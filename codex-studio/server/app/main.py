import hashlib
import os
import json
import uuid
import asyncio
import mimetypes
import shutil
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from .adapters import registry
from .config import project_media_dir, render_dir, settings
from .database import connect, initialize_database
from .schemas import AssetCreate, AssetImportRequest, AssetUpdate, AutomationStartRequest, BibleEntityCreate, ContinuityContractRequest, ContinuityRequest, DirectorBuildRequest, EpisodeAutomationRequest, EpisodeLockRequest, GatewayRequest, ModelRoleBindingUpdate, PipelineUpdate, PreflightRequest, Project, ProjectCreate, ProjectUpdate, ProviderConfigUpdate, QualityReviewRequest, RouteUpdate, SceneLayoutRequest, ScriptUpsert, Shot, ShotCreate, ShotGenerationRequest, ShotUpdate, StoryboardGenerateRequest, TaskCreate, TimelineClipCreate, TimelineClipUpdate, TimelineExportRequest, TimelineReorderRequest, TransitionPlanRequest, TransitionRenderRequest
from .continuity import analyze_pair
from .pipeline import stage_catalog
from .providers import CAPABILITIES, known_provider, providers_for, public_catalog, supports
from .preflight import run_preflight
from .provider_config import all_provider_statuses, delete_provider_config, resolve_provider_config, save_provider_config
from .model_discovery import discover_provider_models
from .model_routing import delete_model_binding, list_model_roles, resolve_model_role, save_model_binding
from .quality import repair_plan, weighted_score
from .story_bible import continuity_contract, episode_snapshot, fingerprint
from .automation import automation_plan
from .previz import analyze_stage, stage_fingerprint
from .transitions import plan_transition
from .task_runner import TaskRunner, serialize_task
from .media import MediaError, capabilities as media_capabilities, probe_media
from .script_engine import extract_characters, parse_scenes, scene_to_shots
from .production import automation_route_plan, bible_context, serialize_run, start_automation
from .director import DIRECTOR_SYSTEM, director_prompt, extract_json_object, normalize_design
from .story_logic import persist_snapshots, recompute_episode


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    runner = TaskRunner()
    worker = asyncio.create_task(runner.run(), name="durable-task-runner")
    try:
        yield
    finally:
        runner.stop()
        await worker


app = FastAPI(title=settings.app_name, version="1.5.4", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost", "http://127.0.0.1"], allow_methods=["*"], allow_headers=["*"])
PREFIX = settings.api_prefix


@app.get(f"{PREFIX}/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "1.5.4", "instance_id": os.getenv("AI_STUDIO_INSTANCE_ID", "external")}


@app.get(f"{PREFIX}/providers")
def provider_catalog(capability: str | None = None):
    if capability and capability not in CAPABILITIES:
        raise HTTPException(400, "Unknown capability")
    return [provider.__dict__ for provider in providers_for(capability)] if capability else public_catalog()


@app.get(f"{PREFIX}/provider-configs")
def provider_configs():
    return all_provider_statuses()


@app.put(f"{PREFIX}/provider-configs/{{provider_id}}")
def configure_provider(provider_id: str, payload: ProviderConfigUpdate):
    try:
        return save_provider_config(provider_id, payload.base_url, payload.model, payload.api_key)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.delete(f"{PREFIX}/provider-configs/{{provider_id}}", status_code=204)
def remove_provider_config(provider_id: str):
    try:
        delete_provider_config(provider_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get(f"{PREFIX}/provider-configs/{{provider_id}}/models")
async def provider_models(provider_id: str, capability: str | None = None):
    if capability and capability not in CAPABILITIES:
        raise HTTPException(400, "Unknown capability")
    try:
        return await discover_provider_models(provider_id, capability)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get(f"{PREFIX}/model-roles")
def model_roles():
    return list_model_roles()


@app.put(f"{PREFIX}/model-roles/{{role_id}}")
def bind_model_role(role_id: str, payload: ModelRoleBindingUpdate):
    try:
        return save_model_binding(role_id, payload.provider_id, payload.model)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.delete(f"{PREFIX}/model-roles/{{role_id}}", status_code=204)
def unbind_model_role(role_id: str):
    try:
        delete_model_binding(role_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get(f"{PREFIX}/pipeline/stages")
def pipeline_stages():
    return stage_catalog()


@app.get(f"{PREFIX}/projects", response_model=list[Project])
def list_projects():
    with connect() as db:
        rows = db.execute("SELECT id,name,genre,episode_count FROM projects ORDER BY created_at DESC").fetchall()
    return [dict(row) for row in rows]


@app.post(f"{PREFIX}/projects", response_model=Project, status_code=201)
def create_project(payload: ProjectCreate):
    project = Project(id=uuid.uuid4().hex, **payload.model_dump())
    with connect() as db:
        db.execute("INSERT INTO projects(id,name,genre,episode_count) VALUES(?,?,?,?)", (project.id, project.name, project.genre, project.episode_count))
    return project


@app.patch(f"{PREFIX}/projects/{{project_id}}", response_model=Project)
def update_project(project_id: str, payload: ProjectUpdate):
    changes = payload.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(400, "No changes")
    with connect() as db:
        cursor = db.execute(f"UPDATE projects SET {','.join(f'{key}=?' for key in changes)} WHERE id=?", (*changes.values(), project_id))
        if not cursor.rowcount:
            raise HTTPException(404, "Project not found")
        row = db.execute("SELECT id,name,genre,episode_count FROM projects WHERE id=?", (project_id,)).fetchone()
    return dict(row)


@app.get(f"{PREFIX}/projects/{{project_id}}/summary")
def project_summary(project_id: str):
    with connect() as db:
        if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise HTTPException(404, "Project not found")
        shots = db.execute("SELECT COUNT(*) FROM shots WHERE project_id=?", (project_id,)).fetchone()[0]
        scenes = db.execute("SELECT COUNT(*) FROM scenes WHERE project_id=?", (project_id,)).fetchone()[0]
        scripts = db.execute("SELECT COUNT(*) FROM episode_scripts WHERE project_id=? AND source_text<>''", (project_id,)).fetchone()[0]
        assets = {row["asset_type"]: row["count"] for row in db.execute("SELECT asset_type,COUNT(*) AS count FROM assets WHERE project_id=? GROUP BY asset_type", (project_id,)).fetchall()}
        bible = {row["entity_type"]: row["count"] for row in db.execute("SELECT entity_type,COUNT(*) AS count FROM bible_entities WHERE project_id=? GROUP BY entity_type", (project_id,)).fetchall()}
    return {
        "scripts": scripts, "scenes": scenes, "shots": shots,
        "characters": max(assets.get("character", 0), bible.get("character", 0)),
        "locations": max(assets.get("scene", 0), bible.get("location", 0)),
        "props": max(assets.get("prop", 0), bible.get("prop", 0)),
    }


@app.delete(f"{PREFIX}/projects/{{project_id}}", status_code=204)
def delete_project(project_id: str):
    with connect() as db:
        if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise HTTPException(404, "Project not found")
        db.execute("DELETE FROM shot_assets WHERE shot_id IN (SELECT id FROM shots WHERE project_id=?)", (project_id,))
        for table in ("episode_scripts", "scenes", "shots", "shot_state_snapshots", "assets", "timeline_clips", "tasks", "automation_runs", "pipeline_runs", "bible_entities", "episode_locks", "continuity_contracts", "quality_reviews", "scene_layouts", "transition_plans"):
            db.execute(f"DELETE FROM {table} WHERE project_id=?", (project_id,))
        db.execute("DELETE FROM projects WHERE id=?", (project_id,))


@app.get(f"{PREFIX}/projects/{{project_id}}/episodes/{{episode}}/script")
def get_episode_script(project_id: str, episode: int):
    with connect() as db:
        row = db.execute(
            "SELECT project_id,episode,title,source_name,source_text,checksum,parse_status,updated_at FROM episode_scripts WHERE project_id=? AND episode=?",
            (project_id, episode),
        ).fetchone()
    if not row:
        return {"project_id": project_id, "episode": episode, "title": "", "source_name": "", "source_text": "", "checksum": "", "parse_status": "empty", "updated_at": None}
    return dict(row)


@app.put(f"{PREFIX}/projects/{{project_id}}/episodes/{{episode}}/script")
def save_episode_script(project_id: str, episode: int, payload: ScriptUpsert):
    if episode < 1:
        raise HTTPException(400, "Episode must be positive")
    checksum = hashlib.sha256(payload.source_text.encode("utf-8")).hexdigest()
    with connect() as db:
        project = db.execute("SELECT episode_count FROM projects WHERE id=?", (project_id,)).fetchone()
        if not project:
            raise HTTPException(404, "Project not found")
        if episode > project["episode_count"]:
            raise HTTPException(400, "Episode exceeds project episode count")
        db.execute(
            "INSERT INTO episode_scripts(project_id,episode,title,source_name,source_text,checksum,parse_status) VALUES(?,?,?,?,?,?,'saved') "
            "ON CONFLICT(project_id,episode) DO UPDATE SET title=excluded.title,source_name=excluded.source_name,source_text=excluded.source_text,checksum=excluded.checksum,parse_status='saved',updated_at=CURRENT_TIMESTAMP",
            (project_id, episode, payload.title, payload.source_name, payload.source_text, checksum),
        )
    return {"project_id": project_id, "episode": episode, "checksum": checksum, "parse_status": "saved"}


@app.post(f"{PREFIX}/projects/{{project_id}}/episodes/{{episode}}/script/parse")
def parse_episode_script(project_id: str, episode: int):
    with connect() as db:
        script = db.execute("SELECT source_text FROM episode_scripts WHERE project_id=? AND episode=?", (project_id, episode)).fetchone()
        if not script or not script["source_text"].strip():
            raise HTTPException(409, "Script is empty")
        scenes = parse_scenes(script["source_text"])
        characters = extract_characters(script["source_text"])
        db.execute("DELETE FROM scenes WHERE project_id=? AND episode=?", (project_id, episode))
        for scene in scenes:
            db.execute(
                "INSERT INTO scenes(project_id,episode,sequence,heading,location,time_of_day,summary,source_text) VALUES(?,?,?,?,?,?,?,?)",
                (project_id, episode, scene.sequence, scene.heading, scene.location, scene.time_of_day, scene.summary, scene.source_text),
            )
            key = f"episode-{episode}-scene-{scene.sequence}"
            data = json.dumps({"heading": scene.heading, "location": scene.location, "time_of_day": scene.time_of_day}, ensure_ascii=False)
            db.execute(
                "INSERT OR IGNORE INTO bible_entities(project_id,entity_type,entity_key,name,state,data_json) VALUES(?,'location',?,?,'draft',?)",
                (project_id, key, scene.location, data),
            )
        for name in characters:
            key = hashlib.sha1(name.encode("utf-8")).hexdigest()[:16]
            db.execute(
                "INSERT OR IGNORE INTO bible_entities(project_id,entity_type,entity_key,name,state,data_json) VALUES(?,'character',?,?,'draft','{}')",
                (project_id, key, name),
            )
        db.execute("UPDATE episode_scripts SET parse_status='parsed',updated_at=CURRENT_TIMESTAMP WHERE project_id=? AND episode=?", (project_id, episode))
    return {
        "project_id": project_id, "episode": episode, "scene_count": len(scenes),
        "character_count": len(characters), "characters": characters,
        "scenes": [scene.__dict__ for scene in scenes],
    }


@app.get(f"{PREFIX}/projects/{{project_id}}/episodes/{{episode}}/scenes")
def list_episode_scenes(project_id: str, episode: int):
    with connect() as db:
        rows = db.execute(
            "SELECT id,episode,sequence,heading,location,time_of_day,summary,source_text FROM scenes WHERE project_id=? AND episode=? ORDER BY sequence",
            (project_id, episode),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post(f"{PREFIX}/projects/{{project_id}}/episodes/{{episode}}/storyboard/generate")
def generate_storyboard(project_id: str, episode: int, payload: StoryboardGenerateRequest):
    with connect() as db:
        scene_rows = db.execute(
            "SELECT id,sequence,heading,location,time_of_day,summary,source_text FROM scenes WHERE project_id=? AND episode=? ORDER BY sequence",
            (project_id, episode),
        ).fetchall()
        if not scene_rows:
            raise HTTPException(409, "Parse the script before generating the storyboard")
        existing = db.execute("SELECT COUNT(*) FROM shots WHERE project_id=? AND episode=?", (project_id, episode)).fetchone()[0]
        if existing and not payload.replace_existing:
            raise HTTPException(409, "Storyboard already exists")
        if payload.replace_existing:
            db.execute("DELETE FROM shots WHERE project_id=? AND episode=?", (project_id, episode))
        next_number = 1
        created = 0
        for row in scene_rows:
            from .script_engine import ParsedScene
            scene = ParsedScene(row["sequence"], row["heading"], row["location"], row["time_of_day"], row["source_text"], row["summary"])
            for item in scene_to_shots(scene, next_number):
                db.execute(
                    "INSERT INTO shots(project_id,episode,scene_id,sequence,number,title,description,duration,status,color,prompt,shot_type,camera,action,dialogue,characters_json,continuity_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (project_id, episode, row["id"], created + 1, item["number"], item["title"], item["description"], item["duration"], item["status"], item["color"], item["prompt"], item["shot_type"], item["camera"], item["action"], item["dialogue"], json.dumps(item["characters"], ensure_ascii=False), json.dumps(item["continuity"], ensure_ascii=False)),
                )
                created += 1
            next_number = created + 1
        db.execute("UPDATE episode_scripts SET parse_status='storyboard',updated_at=CURRENT_TIMESTAMP WHERE project_id=? AND episode=?", (project_id, episode))
    return {"project_id": project_id, "episode": episode, "shot_count": created, "replaced": bool(existing)}


@app.post(f"{PREFIX}/projects/{{project_id}}/episodes/{{episode}}/director/generate")
async def generate_director_package(project_id: str, episode: int, payload: DirectorBuildRequest):
    """Generate and atomically persist the full storyboard, Bible and state graph."""
    with connect() as db:
        script = db.execute(
            "SELECT source_text FROM episode_scripts WHERE project_id=? AND episode=?",
            (project_id, episode),
        ).fetchone()
        if not script or not str(script["source_text"] or "").strip():
            raise HTTPException(409, "请先保存完整剧本")
        existing = db.execute("SELECT COUNT(*) FROM shots WHERE project_id=? AND episode=?", (project_id, episode)).fetchone()[0]
        if existing and not payload.replace_existing:
            raise HTTPException(409, "本集已经存在分镜")
    route = resolve_model_role("storyboard_design")
    provider_id = payload.provider or (route["provider_id"] if route else None)
    if not provider_id:
        raise HTTPException(409, "请先在模型路由中心绑定“全量分镜导演”模型")
    model = payload.model or (route["model"] if route and route["provider_id"] == provider_id else None)
    try:
        adapter = registry.resolve(provider_id)
        result = await adapter.invoke(director_prompt(script["source_text"], episode), {
            "task_type": "llm", "system_prompt": DIRECTOR_SYSTEM, "temperature": 0.15, "max_tokens": 16000,
            "project_id": project_id, "episode": episode, "model": model,
        })
        design = normalize_design(extract_json_object(str(result.get("result") or "")))
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc

    state = "frozen" if payload.freeze_bible else "draft"
    shot_ids: list[int] = []
    with connect() as db:
        if payload.replace_existing:
            old_ids = [row[0] for row in db.execute("SELECT id FROM shots WHERE project_id=? AND episode=?", (project_id, episode)).fetchall()]
            if old_ids:
                marks = ",".join("?" for _ in old_ids)
                db.execute(f"DELETE FROM shot_assets WHERE shot_id IN ({marks})", old_ids)
            db.execute("DELETE FROM shot_state_snapshots WHERE project_id=? AND episode=?", (project_id, episode))
            db.execute("DELETE FROM shots WHERE project_id=? AND episode=?", (project_id, episode))
            db.execute("DELETE FROM scenes WHERE project_id=? AND episode=?", (project_id, episode))
        scene_ids: dict[int, int] = {}
        for scene in design["scenes"]:
            cursor = db.execute(
                "INSERT INTO scenes(project_id,episode,sequence,heading,location,time_of_day,summary,source_text) VALUES(?,?,?,?,?,?,?,?)",
                (project_id, episode, scene["index"], scene["heading"], scene["location"], scene["time_of_day"], scene["summary"], ""),
            )
            scene_ids[int(scene["index"])] = int(cursor.lastrowid)
        for shot in design["shots"]:
            cursor = db.execute(
                "INSERT INTO shots(project_id,episode,scene_id,sequence,number,title,description,duration,status,color,prompt,shot_type,camera,action,dialogue,characters_json,continuity_json,value_score,model_requirement_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (project_id, episode, scene_ids[int(shot["scene_index"])], shot["sequence"], shot["number"], shot["title"], shot["description"], shot["duration"], shot["status"], shot["color"], shot["prompt"], shot["shot_type"], shot["camera"], shot["action"], shot["dialogue"], json.dumps(shot["characters"], ensure_ascii=False), json.dumps(shot["continuity"], ensure_ascii=False), shot["value_score"], json.dumps(shot["model_requirement"], ensure_ascii=False)),
            )
            shot_ids.append(int(cursor.lastrowid))
        findings = persist_snapshots(db, project_id, episode, design["shots"], shot_ids)
        bible_count = 0
        singular = {"characters": "character", "locations": "location", "props": "prop", "world": "world", "style": "style"}
        for group, entity_type in singular.items():
            for entity in design["bible"].get(group, []):
                name = str(entity.get("name") or entity_type).strip()
                entity_key = hashlib.sha1(f"{entity_type}:{name}".encode("utf-8")).hexdigest()[:20]
                version = int(db.execute("SELECT COALESCE(MAX(version),0)+1 FROM bible_entities WHERE project_id=? AND entity_type=? AND entity_key=?", (project_id, entity_type, entity_key)).fetchone()[0])
                mark = fingerprint(entity, [])
                db.execute(
                    "INSERT INTO bible_entities(project_id,entity_type,entity_key,name,version,state,data_json,reference_assets_json,fingerprint) VALUES(?,?,?,?,?,?,?,?,?)",
                    (project_id, entity_type, entity_key, name, version, state, json.dumps(entity, ensure_ascii=False), "[]", mark),
                )
                bible_count += 1
        db.execute("UPDATE episode_scripts SET parse_status='director_storyboard',updated_at=CURRENT_TIMESTAMP WHERE project_id=? AND episode=?", (project_id, episode))
    warnings = list(design["warnings"])
    warnings.extend(f"镜头 {item['shot_number']} 存在未解释的状态跳变：{item['path']}" for item in findings)
    return {
        "project_id": project_id, "episode": episode, "provider": result.get("provider", payload.provider),
        "model": result.get("model", ""), "logline": design["logline"], "scene_count": len(design["scenes"]),
        "shot_count": len(design["shots"]), "bible_count": bible_count, "blocking_state_conflicts": len(findings),
        "warnings": warnings, "replaced": bool(existing),
    }


@app.get(f"{PREFIX}/projects/{{project_id}}/shots", response_model=list[Shot])
def list_shots(project_id: str):
    with connect() as db:
        rows = db.execute("SELECT id,episode,scene_id,sequence,number,title,description,duration,status,color,prompt,shot_type,camera,action,dialogue,characters_json,continuity_json FROM shots WHERE project_id=? ORDER BY episode,sequence,id", (project_id,)).fetchall()
    return [{**{key: row[key] for key in row.keys() if key not in {"characters_json", "continuity_json"}}, "characters": json.loads(row["characters_json"]), "continuity": json.loads(row["continuity_json"])} for row in rows]


@app.post(f"{PREFIX}/projects/{{project_id}}/shots", status_code=201)
def create_shot(project_id: str, payload: ShotCreate):
    with connect() as db:
        exists = db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone()
        if not exists:
            raise HTTPException(404, "Project not found")
        cursor = db.execute(
            "INSERT INTO shots(project_id,episode,scene_id,sequence,number,title,description,duration,status,color,prompt,shot_type,camera,action,dialogue,characters_json,continuity_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (project_id, payload.episode, payload.scene_id, payload.sequence, payload.number, payload.title, payload.description, payload.duration, payload.status, payload.color, payload.prompt, payload.shot_type, payload.camera, payload.action, payload.dialogue, json.dumps(payload.characters, ensure_ascii=False), json.dumps(payload.continuity, ensure_ascii=False)),
        )
        recompute_episode(db, project_id, payload.episode)
    return {"id": cursor.lastrowid, **payload.model_dump()}


@app.patch(f"{PREFIX}/shots/{{shot_id}}")
def update_shot(shot_id: int, payload: ShotUpdate):
    changes = payload.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(400, "No changes")
    if "characters" in changes:
        changes["characters_json"] = json.dumps(changes.pop("characters"), ensure_ascii=False)
    if "continuity" in changes:
        changes["continuity_json"] = json.dumps(changes.pop("continuity"), ensure_ascii=False)
    columns = ",".join(f"{key}=?" for key in changes)
    with connect() as db:
        current = db.execute("SELECT project_id,episode FROM shots WHERE id=?", (shot_id,)).fetchone()
        if not current:
            raise HTTPException(404, "Shot not found")
        cursor = db.execute(f"UPDATE shots SET {columns} WHERE id=?", (*changes.values(), shot_id))
        recompute_episode(db, current["project_id"], int(current["episode"]))
    return {"id": shot_id, **changes}


@app.post(f"{PREFIX}/projects/{{project_id}}/assets", status_code=201)
def create_asset(project_id: str, payload: AssetCreate):
    with connect() as db:
        cursor = db.execute("INSERT INTO assets(project_id,asset_type,name,memory_json) VALUES(?,?,?,?)", (project_id, payload.asset_type, payload.name, json.dumps(payload.memory, ensure_ascii=False)))
    return {"id": cursor.lastrowid, **payload.model_dump()}


def _asset_dict(row):
    return {**{key: row[key] for key in row.keys() if key not in {"memory_json", "metadata_json"}}, "memory": json.loads(row["memory_json"]), "metadata": json.loads(row["metadata_json"])}


@app.get(f"{PREFIX}/projects/{{project_id}}/assets")
def list_assets(project_id: str, asset_type: str | None = None, episode: int | None = None):
    query = "SELECT * FROM assets WHERE project_id=?"
    args: list[object] = [project_id]
    if asset_type:
        query += " AND asset_type=?"; args.append(asset_type)
    if episode:
        query += " AND episode=?"; args.append(episode)
    query += " ORDER BY created_at DESC,id DESC"
    with connect() as db:
        rows = db.execute(query, args).fetchall()
    return [_asset_dict(row) for row in rows]


@app.post(f"{PREFIX}/projects/{{project_id}}/assets/import", status_code=201)
def import_asset(project_id: str, payload: AssetImportRequest):
    source = Path(payload.source_path).expanduser().resolve()
    if not source.is_file():
        raise HTTPException(404, "Source file not found")
    with connect() as db:
        if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise HTTPException(404, "Project not found")
    target = source
    if payload.copy_into_project:
        folder = project_media_dir(project_id) / "imported"
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"{uuid.uuid4().hex[:10]}-{source.name}"
        shutil.copy2(source, target)
    metadata: dict[str, object] = {"source_path": str(source), "size_bytes": target.stat().st_size}
    if payload.asset_type == "video":
        try: metadata.update(probe_media(str(target)))
        except MediaError as exc: raise HTTPException(422, str(exc)) from exc
    mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    with connect() as db:
        cursor = db.execute(
            "INSERT INTO assets(project_id,asset_type,name,episode,shot_id,local_path,mime_type,source_kind,status,memory_json,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (project_id, payload.asset_type, payload.name or source.stem, payload.episode, payload.shot_id, str(target), mime, "manual", "ready", json.dumps(payload.memory, ensure_ascii=False), json.dumps(metadata, ensure_ascii=False)),
        )
        if payload.shot_id:
            db.execute("INSERT OR IGNORE INTO shot_assets(shot_id,asset_id,role) VALUES(?,?,?)", (payload.shot_id, cursor.lastrowid, payload.asset_type))
        row = db.execute("SELECT * FROM assets WHERE id=?", (cursor.lastrowid,)).fetchone()
    return _asset_dict(row)


@app.patch(f"{PREFIX}/assets/{{asset_id}}")
def update_asset(asset_id: int, payload: AssetUpdate):
    changes = payload.model_dump(exclude_none=True)
    if "memory" in changes: changes["memory_json"] = json.dumps(changes.pop("memory"), ensure_ascii=False)
    if "metadata" in changes: changes["metadata_json"] = json.dumps(changes.pop("metadata"), ensure_ascii=False)
    if not changes: raise HTTPException(400, "No changes")
    with connect() as db:
        cursor = db.execute(f"UPDATE assets SET {','.join(f'{key}=?' for key in changes)} WHERE id=?", (*changes.values(), asset_id))
        if not cursor.rowcount: raise HTTPException(404, "Asset not found")
        row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
    return _asset_dict(row)


@app.delete(f"{PREFIX}/assets/{{asset_id}}", status_code=204)
def delete_asset(asset_id: int, delete_file: bool = False):
    with connect() as db:
        row = db.execute("SELECT local_path,source_kind FROM assets WHERE id=?", (asset_id,)).fetchone()
        if not row: raise HTTPException(404, "Asset not found")
        db.execute("DELETE FROM shot_assets WHERE asset_id=?", (asset_id,))
        db.execute("DELETE FROM assets WHERE id=?", (asset_id,))
    if delete_file and row["source_kind"] in {"manual", "generated"} and row["local_path"]:
        try:
            path = Path(row["local_path"]).resolve()
            root = settings.database_path.parent.resolve()
            if root in path.parents: path.unlink(missing_ok=True)
        except OSError: pass


@app.post(f"{PREFIX}/projects/{{project_id}}/shots/generate", status_code=202)
def generate_shot_media(project_id: str, payload: ShotGenerationRequest):
    capability = {"image": "t2i", "video": "i2v", "voice": "tts"}[payload.task_type]
    if (known_provider(payload.provider) and not supports(payload.provider, capability)) or (not known_provider(payload.provider) and not registry.has(payload.provider)):
        raise HTTPException(422, f"{payload.provider} 当前没有已维护的 {capability} 适配器")
    with connect() as db:
        shot = db.execute("SELECT * FROM shots WHERE id=? AND project_id=?", (payload.shot_id, project_id)).fetchone()
        if not shot: raise HTTPException(404, "Shot not found")
        reference_rows = []
        if payload.reference_asset_ids:
            marks = ",".join("?" for _ in payload.reference_asset_ids)
            reference_rows = db.execute(f"SELECT id,local_path FROM assets WHERE project_id=? AND id IN ({marks})", (project_id, *payload.reference_asset_ids)).fetchall()
        reference_paths = [row["local_path"] for row in reference_rows if row["local_path"]]
        memory_block, bible_references = bible_context(db, project_id, shot)
        reference_paths = list(dict.fromkeys(reference_paths + bible_references))
        task_payload = {
            "project_id": project_id, "episode": shot["episode"], "shot_id": shot["id"], "shot_number": shot["number"],
            "prompt": payload.prompt + memory_block, "model": payload.model, "reference_asset_ids": payload.reference_asset_ids,
            "reference_paths": reference_paths, "options": payload.options,
        }
        cursor = db.execute("INSERT INTO tasks(project_id,task_type,provider,payload_json,priority,max_attempts) VALUES(?,?,?,?,?,?)", (project_id, payload.task_type, payload.provider, json.dumps(task_payload, ensure_ascii=False), 50, 3))
    return {"id": cursor.lastrowid, "status": "queued", "shot_id": payload.shot_id, "task_type": payload.task_type}


def _timeline_clip(row):
    return {**{key: row[key] for key in row.keys() if key != "metadata_json"}, "metadata": json.loads(row["metadata_json"])}


@app.get(f"{PREFIX}/projects/{{project_id}}/timeline")
def list_timeline(project_id: str, episode: int = 1):
    with connect() as db:
        rows = db.execute("SELECT * FROM timeline_clips WHERE project_id=? AND episode=? ORDER BY track,position,id", (project_id, episode)).fetchall()
    return [_timeline_clip(row) for row in rows]


@app.post(f"{PREFIX}/projects/{{project_id}}/timeline", status_code=201)
def add_timeline_clip(project_id: str, payload: TimelineClipCreate):
    source = Path(payload.source_path).expanduser().resolve()
    if not source.is_file(): raise HTTPException(404, "Media file not found")
    duration = payload.duration
    if payload.track.startswith("V") and duration <= 0:
        try: duration = float(probe_media(str(source))["duration"])
        except MediaError as exc: raise HTTPException(422, str(exc)) from exc
    with connect() as db:
        position = db.execute("SELECT COALESCE(MAX(position),-1)+1 FROM timeline_clips WHERE project_id=? AND episode=? AND track=?", (project_id, payload.episode, payload.track)).fetchone()[0]
        cursor = db.execute(
            "INSERT INTO timeline_clips(project_id,episode,track,position,asset_id,source_path,title,trim_in,trim_out,duration,transition,transition_duration,volume,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (project_id, payload.episode, payload.track, position, payload.asset_id, str(source), payload.title or source.stem, payload.trim_in, payload.trim_out, duration, payload.transition, payload.transition_duration, payload.volume, json.dumps(payload.metadata, ensure_ascii=False)),
        )
        row = db.execute("SELECT * FROM timeline_clips WHERE id=?", (cursor.lastrowid,)).fetchone()
    return _timeline_clip(row)


@app.post(f"{PREFIX}/projects/{{project_id}}/timeline/from-storyboard")
def timeline_from_storyboard(project_id: str, episode: int = 1, replace: bool = True):
    with connect() as db:
        rows = db.execute(
            "SELECT a.id,a.local_path,a.name,s.number FROM shots s JOIN shot_assets sa ON sa.shot_id=s.id AND sa.role='video' JOIN assets a ON a.id=sa.asset_id WHERE s.project_id=? AND s.episode=? ORDER BY s.sequence,s.id,a.id DESC",
            (project_id, episode),
        ).fetchall()
        unique = {}
        for row in rows:
            unique.setdefault(row["number"], row)
        if replace: db.execute("DELETE FROM timeline_clips WHERE project_id=? AND episode=? AND track='V1'", (project_id, episode))
        created = 0
        for position, row in enumerate(unique.values()):
            try: duration = probe_media(row["local_path"])["duration"]
            except MediaError: continue
            db.execute("INSERT INTO timeline_clips(project_id,episode,track,position,asset_id,source_path,title,duration,transition) VALUES(?,?,'V1',?,?,?,?,?,'cut')", (project_id, episode, position, row["id"], row["local_path"], f"镜头 {row['number']} · {row['name']}", duration))
            created += 1
    return {"created": created, "episode": episode}


@app.patch(f"{PREFIX}/timeline/{{clip_id}}")
def update_timeline_clip(clip_id: int, payload: TimelineClipUpdate):
    changes = payload.model_dump(exclude_none=True)
    if not changes: raise HTTPException(400, "No changes")
    with connect() as db:
        cursor = db.execute(f"UPDATE timeline_clips SET {','.join(f'{key}=?' for key in changes)} WHERE id=?", (*changes.values(), clip_id))
        if not cursor.rowcount: raise HTTPException(404, "Timeline clip not found")
        row = db.execute("SELECT * FROM timeline_clips WHERE id=?", (clip_id,)).fetchone()
    return _timeline_clip(row)


@app.post(f"{PREFIX}/projects/{{project_id}}/timeline/reorder")
def reorder_timeline(project_id: str, payload: TimelineReorderRequest):
    with connect() as db:
        for position, clip_id in enumerate(payload.clip_ids):
            db.execute("UPDATE timeline_clips SET position=? WHERE id=? AND project_id=?", (position, clip_id, project_id))
    return {"clip_ids": payload.clip_ids}


@app.delete(f"{PREFIX}/timeline/{{clip_id}}", status_code=204)
def delete_timeline_clip(clip_id: int):
    with connect() as db:
        cursor = db.execute("DELETE FROM timeline_clips WHERE id=?", (clip_id,))
        if not cursor.rowcount: raise HTTPException(404, "Timeline clip not found")


@app.post(f"{PREFIX}/projects/{{project_id}}/timeline/export", status_code=202)
def export_timeline(project_id: str, payload: TimelineExportRequest):
    with connect() as db:
        count = db.execute("SELECT COUNT(*) FROM timeline_clips WHERE project_id=? AND episode=? AND track IN ('V1','V2')", (project_id, payload.episode)).fetchone()[0]
        if not count: raise HTTPException(409, "Timeline has no video clips")
        cursor = db.execute("INSERT INTO tasks(project_id,task_type,provider,payload_json,priority,max_attempts) VALUES(?,?,?,?,?,1)", (project_id, "timeline_export", "ffmpeg", json.dumps(payload.model_dump(), ensure_ascii=False), 100))
    return {"id": cursor.lastrowid, "status": "queued", "clip_count": count}


@app.post(f"{PREFIX}/projects/{{project_id}}/tasks", status_code=202)
def create_task(project_id: str, payload: TaskCreate):
    with connect() as db:
        if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise HTTPException(404, "Project not found")
        cursor = db.execute("INSERT INTO tasks(project_id,task_type,provider,payload_json,priority,max_attempts) VALUES(?,?,?,?,?,?)", (project_id, payload.task_type, payload.provider, json.dumps({"project_id": project_id, **payload.payload}, ensure_ascii=False), payload.priority, payload.max_attempts))
    return {"id": cursor.lastrowid, "status": "queued", **payload.model_dump()}


@app.get(f"{PREFIX}/projects/{{project_id}}/tasks")
def list_tasks(project_id: str):
    with connect() as db:
        rows = db.execute("SELECT * FROM tasks WHERE project_id=? ORDER BY id DESC", (project_id,)).fetchall()
    return [serialize_task(row) for row in rows]


@app.get(f"{PREFIX}/tasks/stats")
def task_stats():
    with connect() as db:
        rows = db.execute("SELECT status,COUNT(*) AS count FROM tasks GROUP BY status").fetchall()
    counts = {row["status"]: row["count"] for row in rows}
    return {"total": sum(counts.values()), "by_status": counts, "active": counts.get("queued", 0) + counts.get("running", 0) + counts.get("retry_wait", 0)}


@app.post(f"{PREFIX}/tasks/{{task_id}}/cancel", status_code=202)
def cancel_task(task_id: int):
    with connect() as db:
        row = db.execute("SELECT status FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Task not found")
        if row["status"] in {"completed", "failed", "canceled"}:
            raise HTTPException(409, "Task is already terminal")
        status = "canceled" if row["status"] in {"queued", "retry_wait"} else row["status"]
        db.execute("UPDATE tasks SET status=?,cancel_requested=1,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?", (status, task_id))
    return {"id": task_id, "status": status, "cancel_requested": True}


@app.post(f"{PREFIX}/tasks/{{task_id}}/retry", status_code=202)
def retry_task(task_id: int):
    with connect() as db:
        row = db.execute("SELECT status FROM tasks WHERE id=?", (task_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Task not found")
        if row["status"] not in {"failed", "canceled"}:
            raise HTTPException(409, "Only failed or canceled tasks can be retried")
        db.execute("UPDATE tasks SET status='queued',progress=0,attempts=0,cancel_requested=0,error_message='',result_json='{}',provider_task_id='',provider_state_json='{}',available_at=CURRENT_TIMESTAMP,completed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?", (task_id,))
    return {"id": task_id, "status": "queued"}


@app.post(f"{PREFIX}/preflight")
def preflight(payload: PreflightRequest):
    return run_preflight(payload.checks)


@app.post(f"{PREFIX}/projects/{{project_id}}/bible", status_code=201)
def create_bible_version(project_id: str, payload: BibleEntityCreate):
    references: list[str] = []
    bible_folder = project_media_dir(project_id) / "bible"
    bible_folder.mkdir(parents=True, exist_ok=True)
    project_root = project_media_dir(project_id).resolve()
    for value in payload.reference_assets:
        source = Path(value).expanduser().resolve()
        if source.is_file():
            if project_root in source.parents:
                target = source
            else:
                target = bible_folder / f"{uuid.uuid4().hex[:10]}-{source.name}"
                shutil.copy2(source, target)
            references.append(str(target))
        elif value.startswith("asset://"):
            references.append(value)
    data = {**payload.model_dump(), "reference_assets": references}
    mark = fingerprint(payload.data, references)
    with connect() as db:
        row = db.execute("SELECT COALESCE(MAX(version),0)+1 FROM bible_entities WHERE project_id=? AND entity_type=? AND entity_key=?", (project_id, payload.entity_type, payload.entity_key)).fetchone()
        version = row[0]
        cursor = db.execute("INSERT INTO bible_entities(project_id,entity_type,entity_key,name,version,state,data_json,reference_assets_json,fingerprint) VALUES(?,?,?,?,?,?,?,?,?)", (project_id, payload.entity_type, payload.entity_key, payload.name, version, payload.state, json.dumps(payload.data, ensure_ascii=False), json.dumps(references, ensure_ascii=False), mark))
    return {"id": cursor.lastrowid, "version": version, "fingerprint": mark, **data}


@app.get(f"{PREFIX}/projects/{{project_id}}/bible")
def list_bible(project_id: str, latest_only: bool = True):
    query = "SELECT * FROM bible_entities WHERE project_id=?"
    if latest_only:
        query += " AND version=(SELECT MAX(b2.version) FROM bible_entities b2 WHERE b2.project_id=bible_entities.project_id AND b2.entity_type=bible_entities.entity_type AND b2.entity_key=bible_entities.entity_key)"
    query += " ORDER BY entity_type,name,version"
    with connect() as db:
        rows = db.execute(query, (project_id,)).fetchall()
    return [{**dict(row), "data": json.loads(row["data_json"]), "reference_assets": json.loads(row["reference_assets_json"])} for row in rows]


@app.put(f"{PREFIX}/projects/{{project_id}}/continuity-contracts")
def save_continuity_contract(project_id: str, payload: ContinuityContractRequest):
    raw = payload.model_dump()
    contract, findings, score = continuity_contract(raw)
    with connect() as db:
        db.execute("INSERT INTO continuity_contracts(project_id,episode,from_shot,to_shot,relation,contract_json,score,findings_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,episode,from_shot,to_shot) DO UPDATE SET relation=excluded.relation,contract_json=excluded.contract_json,score=excluded.score,findings_json=excluded.findings_json,updated_at=CURRENT_TIMESTAMP", (project_id, payload.episode, payload.from_shot, payload.to_shot, payload.relation, json.dumps(contract, ensure_ascii=False), score, json.dumps(findings, ensure_ascii=False)))
    return {"project_id": project_id, **raw, "contract": contract, "score": score, "findings": findings}


@app.post(f"{PREFIX}/projects/{{project_id}}/episode-locks")
def lock_episode(project_id: str, payload: EpisodeLockRequest):
    with connect() as db:
        shot_rows = db.execute("SELECT number,title,description,duration,status,prompt FROM shots WHERE project_id=? AND episode=? ORDER BY number", (project_id, payload.episode)).fetchall()
        bible_rows = db.execute("SELECT entity_type,entity_key,state,fingerprint FROM bible_entities WHERE project_id=? AND version=(SELECT MAX(b2.version) FROM bible_entities b2 WHERE b2.project_id=bible_entities.project_id AND b2.entity_type=bible_entities.entity_type AND b2.entity_key=bible_entities.entity_key)", (project_id,)).fetchall()
        contract_rows = db.execute("SELECT from_shot,to_shot,relation,score,findings_json FROM continuity_contracts WHERE project_id=? AND episode=? ORDER BY from_shot", (project_id, payload.episode)).fetchall()
        snapshot = episode_snapshot([dict(row) for row in shot_rows], [dict(row) for row in bible_rows], [{**dict(row), "findings": json.loads(row["findings_json"])} for row in contract_rows])
        blockers = [item for item in snapshot["contracts"] if item["score"] < 70]
        if (not snapshot["ready"] or blockers) and not payload.force:
            raise HTTPException(409, {"message": "全量分镜或设定未通过锁定条件", "ready": snapshot["ready"], "blocking_contracts": blockers})
        current = db.execute("SELECT revision FROM episode_locks WHERE project_id=? AND episode=?", (project_id, payload.episode)).fetchone()
        revision = (current[0] + 1) if current else 1
        db.execute("INSERT INTO episode_locks(project_id,episode,revision,status,snapshot_json,locked_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(project_id,episode) DO UPDATE SET revision=excluded.revision,status=excluded.status,snapshot_json=excluded.snapshot_json,locked_at=CURRENT_TIMESTAMP", (project_id, payload.episode, revision, "locked", json.dumps(snapshot, ensure_ascii=False)))
    return {"project_id": project_id, "episode": payload.episode, "revision": revision, "status": "locked", "snapshot": snapshot}


@app.post(f"{PREFIX}/projects/{{project_id}}/quality-reviews", status_code=201)
def quality_review(project_id: str, payload: QualityReviewRequest):
    score = weighted_score(payload.dimensions)
    has_critical_dimension = any(value < 70 for value in payload.dimensions.values())
    status = "passed" if score >= 80 and not has_critical_dimension and not any(item.get("severity") == "blocking" for item in payload.findings) else "repair_required"
    plan = repair_plan(payload.dimensions, payload.findings) if payload.auto_repair else {"required": False, "actions": []}
    with connect() as db:
        cursor = db.execute("INSERT INTO quality_reviews(project_id,episode,shot_number,score,status,dimensions_json,findings_json,repair_plan_json) VALUES(?,?,?,?,?,?,?,?)", (project_id, payload.episode, payload.shot_number, score, status, json.dumps(payload.dimensions), json.dumps(payload.findings, ensure_ascii=False), json.dumps(plan, ensure_ascii=False)))
    return {"id": cursor.lastrowid, "score": score, "status": status, "repair_plan": plan, **payload.model_dump()}


@app.post(f"{PREFIX}/projects/{{project_id}}/previz/layouts", status_code=201)
def save_scene_layout(project_id: str, payload: SceneLayoutRequest):
    layout = payload.model_dump()
    mark = stage_fingerprint(layout)
    with connect() as db:
        row = db.execute("SELECT COALESCE(MAX(version),0)+1 FROM scene_layouts WHERE project_id=? AND scene_key=?", (project_id, payload.scene_key)).fetchone()
        version = row[0]
        cursor = db.execute("INSERT INTO scene_layouts(project_id,scene_key,version,layout_json,fingerprint) VALUES(?,?,?,?,?)", (project_id, payload.scene_key, version, json.dumps(layout, ensure_ascii=False), mark))
    return {"id": cursor.lastrowid, "version": version, "fingerprint": mark, "analysis": analyze_stage(layout), **layout}


@app.post(f"{PREFIX}/previz/analyze")
def analyze_previz(payload: SceneLayoutRequest):
    return analyze_stage(payload.model_dump())


@app.post(f"{PREFIX}/projects/{{project_id}}/transition-plans", status_code=201)
def create_transition_plan(project_id: str, payload: TransitionPlanRequest):
    raw = payload.model_dump()
    plan = plan_transition(raw)
    with connect() as db:
        db.execute("INSERT INTO transition_plans(project_id,episode,from_shot,to_shot,method,score,plan_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,episode,from_shot,to_shot) DO UPDATE SET method=excluded.method,score=excluded.score,plan_json=excluded.plan_json,status='planned'", (project_id, payload.episode, payload.left.shot_number, payload.right.shot_number, plan["method"], plan["score"], json.dumps(plan, ensure_ascii=False)))
    return {"project_id": project_id, **plan}


@app.get(f"{PREFIX}/media/capabilities")
def get_media_capabilities():
    return media_capabilities()


@app.get(f"{PREFIX}/media/probe")
def inspect_media(path: str):
    try:
        return probe_media(path)
    except MediaError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post(f"{PREFIX}/projects/{{project_id}}/transition-renders", status_code=202)
def queue_transition_render(project_id: str, payload: TransitionRenderRequest):
    task_payload = {"project_id": project_id, **payload.model_dump()}
    with connect() as db:
        if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise HTTPException(404, "Project not found")
        cursor = db.execute(
            "INSERT INTO tasks(project_id,task_type,provider,payload_json,priority,max_attempts) VALUES(?,?,?,?,?,?)",
            (project_id, "transition_render", "ffmpeg", json.dumps(task_payload, ensure_ascii=False), 30, 1),
        )
    return {"id": cursor.lastrowid, "status": "queued", "method": payload.method}


@app.get(f"{PREFIX}/tasks/{{task_id}}/output")
def download_task_output(task_id: int):
    with connect() as db:
        row = db.execute("SELECT status,result_json FROM tasks WHERE id=?", (task_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Task not found")
    if row["status"] != "completed":
        raise HTTPException(409, "Task output is not ready")
    output = Path(json.loads(row["result_json"]).get("output_path", "")).resolve()
    root = render_dir().resolve()
    if not output.is_file() or root not in output.parents:
        raise HTTPException(404, "Output file not found")
    return FileResponse(output, media_type="video/mp4", filename=output.name)


@app.post(f"{PREFIX}/projects/{{project_id}}/automation/plan")
def plan_episode_automation(project_id: str, payload: EpisodeAutomationRequest):
    with connect() as db:
        shot_count = db.execute("SELECT COUNT(*) FROM shots WHERE project_id=? AND episode=?", (project_id, payload.episode)).fetchone()[0]
        rows = db.execute("SELECT from_shot,to_shot,score,findings_json FROM continuity_contracts WHERE project_id=? AND episode=? AND score<70", (project_id, payload.episode)).fetchall()
    blockers = [{**dict(row), "findings": json.loads(row["findings_json"])} for row in rows]
    return automation_plan(payload.episode, payload.mode, shot_count, blockers)


@app.post(f"{PREFIX}/projects/{{project_id}}/automation/start", status_code=202)
def start_episode_automation(project_id: str, payload: AutomationStartRequest):
    with connect() as db:
        if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise HTTPException(404, "Project not found")
    config = payload.model_dump()
    if payload.use_role_bindings:
        for role_id, provider_key, model_key in (
            ("keyframe_image", "image_provider", "image_model"),
            ("reference_image", "reference_image_provider", "reference_image_model"),
            ("shot_video", "video_provider", "video_model"),
            ("transition_video", "transition_provider", "transition_model"),
            ("dialogue_voice", "voice_provider", "voice_model"),
            ("continuity_review", "quality_provider", "quality_model"),
            ("final_review", "final_review_provider", "final_review_model"),
        ):
            route = resolve_model_role(role_id)
            if route:
                config[provider_key], config[model_key] = route["provider_id"], route["model"]
    checks = [(config["image_provider"], "t2i"), (config["video_provider"], "i2v")]
    if config.get("voice_provider"):
        checks.append((config["voice_provider"], "tts"))
    if config.get("quality_provider"):
        checks.append((config["quality_provider"], "vision"))
    if config.get("reference_image_provider"):
        checks.append((config["reference_image_provider"], "i2i"))
    if config.get("transition_provider"):
        checks.append((config["transition_provider"], "i2v"))
    if config.get("final_review_provider"):
        checks.append((config["final_review_provider"], "vision"))
    unsupported = [f"{provider}:{capability}" for provider, capability in checks if (known_provider(provider) and not supports(provider, capability)) or (not known_provider(provider) and not registry.has(provider))]
    if unsupported:
        raise HTTPException(422, "未实现或已停止维护的模型能力：" + "、".join(unsupported))
    try:
        if config["video_provider"] == "metaso" and resolve_provider_config("dashscope", "i2v").api_key:
            config["video_fallback_provider"] = "dashscope"
            config["video_fallback_model"] = "wan2.7-i2v-2026-04-25"
            config["value_routing_enabled"] = True
        return start_automation(project_id, config)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post(f"{PREFIX}/projects/{{project_id}}/automation/route-plan")
def preview_episode_routes(project_id: str, payload: AutomationStartRequest):
    with connect() as db:
        if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise HTTPException(404, "Project not found")
    config = payload.model_dump()
    if payload.use_role_bindings:
        for role_id, provider_key, model_key in (
            ("keyframe_image", "image_provider", "image_model"),
            ("reference_image", "reference_image_provider", "reference_image_model"),
            ("shot_video", "video_provider", "video_model"),
            ("transition_video", "transition_provider", "transition_model"),
            ("dialogue_voice", "voice_provider", "voice_model"),
            ("continuity_review", "quality_provider", "quality_model"),
            ("final_review", "final_review_provider", "final_review_model"),
        ):
            route = resolve_model_role(role_id)
            if route:
                config[provider_key], config[model_key] = route["provider_id"], route["model"]
    if config["video_provider"] == "metaso" and resolve_provider_config("dashscope", "i2v").api_key:
        config.update({"video_fallback_provider": "dashscope", "video_fallback_model": "wan2.7-i2v-2026-04-25", "value_routing_enabled": True})
    return automation_route_plan(project_id, config)


@app.get(f"{PREFIX}/projects/{{project_id}}/automation/runs")
def list_automation_runs(project_id: str):
    with connect() as db:
        rows = db.execute("SELECT * FROM automation_runs WHERE project_id=? ORDER BY id DESC", (project_id,)).fetchall()
    return [serialize_run(row) for row in rows]


@app.post(f"{PREFIX}/automation/runs/{{run_id}}/cancel", status_code=202)
def cancel_automation_run(run_id: int):
    with connect() as db:
        row = db.execute("SELECT status FROM automation_runs WHERE id=?", (run_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Automation run not found")
        if row["status"] in {"completed", "failed", "canceled"}:
            raise HTTPException(409, "Automation run is already terminal")
        db.execute("UPDATE automation_runs SET status='canceled',cancel_requested=1,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?", (run_id,))
        db.execute("UPDATE tasks SET cancel_requested=1,status=CASE WHEN status IN ('queued','retry_wait') THEN 'canceled' ELSE status END,updated_at=CURRENT_TIMESTAMP WHERE automation_run_id=? AND status NOT IN ('completed','failed','canceled')", (run_id,))
    return {"id": run_id, "status": "canceled"}


@app.post(f"{PREFIX}/gateway/{{capability}}")
async def gateway(capability: str, payload: GatewayRequest):
    if capability not in {"llm", "image", "video", "voice", "memory"}:
        raise HTTPException(404, "Unknown AI capability")
    try:
        route = resolve_model_role(payload.role_id) if payload.role_id else None
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    provider_id = payload.provider or (route["provider_id"] if route else "mock")
    context = dict(payload.context)
    if route and provider_id == route["provider_id"]:
        context["model"] = route["model"]
        context["model_role"] = route["role_id"]
    try:
        adapter = registry.resolve(provider_id)
    except KeyError as exc:
        raise HTTPException(400, str(exc)) from exc
    try:
        return {"capability": capability, **await adapter.invoke(payload.prompt, context)}
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc


@app.post(f"{PREFIX}/continuity/analyze")
def continuity_analyze(payload: ContinuityRequest):
    return analyze_pair(payload.previous, payload.current)


@app.put(f"{PREFIX}/projects/{{project_id}}/pipeline/{{stage}}")
def update_pipeline(project_id: str, stage: str, payload: PipelineUpdate):
    valid = {item["id"] for item in stage_catalog()}
    if stage not in valid:
        raise HTTPException(404, "Unknown pipeline stage")
    with connect() as db:
        db.execute(
            "INSERT INTO pipeline_runs(project_id,stage,status,progress,checkpoint_json) VALUES(?,?,?,?,?) "
            "ON CONFLICT(project_id,stage) DO UPDATE SET status=excluded.status,progress=excluded.progress,checkpoint_json=excluded.checkpoint_json,updated_at=CURRENT_TIMESTAMP",
            (project_id, stage, payload.status, payload.progress, json.dumps(payload.checkpoint, ensure_ascii=False)),
        )
    return {"project_id": project_id, "stage": stage, **payload.model_dump()}


@app.get(f"{PREFIX}/projects/{{project_id}}/pipeline")
def pipeline_status(project_id: str):
    with connect() as db:
        rows = db.execute("SELECT stage,status,progress,checkpoint_json,updated_at FROM pipeline_runs WHERE project_id=?", (project_id,)).fetchall()
    stored = {row["stage"]: dict(row) for row in rows}
    result = []
    for stage in stage_catalog():
        current = stored.get(stage["id"], {"status": "pending", "progress": 0, "checkpoint_json": "{}", "updated_at": None})
        result.append({**stage, "status": current["status"], "progress": current["progress"], "checkpoint": json.loads(current["checkpoint_json"]), "updated_at": current["updated_at"]})
    return result


@app.get(f"{PREFIX}/projects/{{project_id}}/proofread")
def proofread(project_id: str):
    with connect() as db:
        rows = db.execute(
            "SELECT number,scene_id,action,characters_json,continuity_json FROM shots WHERE project_id=? ORDER BY episode,sequence,id",
            (project_id,),
        ).fetchall()
        state_rows = db.execute("SELECT s.number,ss.conflicts_json FROM shot_state_snapshots ss JOIN shots s ON s.id=ss.shot_id WHERE ss.project_id=? ORDER BY s.episode,s.sequence,s.id", (project_id,)).fetchall()
    shots = []
    for row in rows:
        continuity = json.loads(row["continuity_json"] or "{}")
        continuity.update({"number": row["number"], "scene": continuity.get("scene") or str(row["scene_id"] or ""),
                           "action": row["action"], "characters": json.loads(row["characters_json"] or "[]")})
        shots.append(continuity)
    findings: list[dict[str, str]] = []
    scores: list[int] = []
    for previous, current in zip(shots, shots[1:]):
        result = analyze_pair(previous, current)
        scores.append(result["score"])
        for item in result["findings"]:
            findings.append({"shot": f"{previous['number']}→{current['number']}", "message": item["message"],
                             "action": "adjust_axis" if item["type"] == "axis" else "adjust_lighting", "severity": item["severity"]})
    state_conflicts = 0
    for row in state_rows:
        for item in json.loads(row["conflicts_json"] or "[]"):
            state_conflicts += 1
            kind = str(item.get("type") or "story_state")
            message = str(item.get("message") or f"故事状态跳变：{item.get('path')}，应为 {item.get('expected')}，实际为 {item.get('actual')}")
            action = "fix_action_phase" if kind in {"action_phase", "action_phase_gap", "action_chain", "momentum"} else "fix_story_state"
            findings.append({"shot": str(row["number"]), "message": message, "action": action, "severity": "blocking"})
    score = round(sum(scores) / len(scores)) if scores else (100 if shots else 0)
    score = max(0, score - state_conflicts * 20)
    return {"project_id": project_id, "score": score, "shot_count": len(shots), "state_conflicts": state_conflicts, "findings": findings}
