import hashlib
import json
import uuid
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from .adapters import registry
from .config import render_dir, settings
from .database import connect, initialize_database
from .schemas import AssetCreate, BibleEntityCreate, ContinuityContractRequest, ContinuityRequest, EpisodeAutomationRequest, EpisodeLockRequest, GatewayRequest, PipelineUpdate, PreflightRequest, Project, ProjectCreate, ProviderConfigUpdate, QualityReviewRequest, RouteUpdate, SceneLayoutRequest, ScriptUpsert, Shot, ShotCreate, ShotUpdate, StoryboardGenerateRequest, TaskCreate, TransitionPlanRequest, TransitionRenderRequest
from .continuity import analyze_pair
from .pipeline import stage_catalog
from .providers import CAPABILITIES, providers_for, public_catalog
from .preflight import run_preflight
from .provider_config import all_provider_statuses, delete_provider_config, save_provider_config
from .quality import repair_plan, weighted_score
from .story_bible import continuity_contract, episode_snapshot, fingerprint
from .automation import automation_plan
from .previz import analyze_stage, stage_fingerprint
from .transitions import plan_transition
from .task_runner import TaskRunner, serialize_task
from .media import MediaError, capabilities as media_capabilities, probe_media
from .script_engine import extract_characters, parse_scenes, scene_to_shots


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


app = FastAPI(title=settings.app_name, version="0.7.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost", "http://127.0.0.1"], allow_methods=["*"], allow_headers=["*"])
PREFIX = settings.api_prefix


@app.get(f"{PREFIX}/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.7.0"}


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
        cursor = db.execute("DELETE FROM projects WHERE id=?", (project_id,))
        if not cursor.rowcount:
            raise HTTPException(404, "Project not found")
        for table in ("episode_scripts", "scenes", "shots", "assets", "tasks", "pipeline_runs", "bible_entities", "episode_locks", "continuity_contracts", "quality_reviews", "scene_layouts", "transition_plans"):
            db.execute(f"DELETE FROM {table} WHERE project_id=?", (project_id,))


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
        cursor = db.execute(f"UPDATE shots SET {columns} WHERE id=?", (*changes.values(), shot_id))
        if not cursor.rowcount:
            raise HTTPException(404, "Shot not found")
    return {"id": shot_id, **changes}


@app.post(f"{PREFIX}/projects/{{project_id}}/assets", status_code=201)
def create_asset(project_id: str, payload: AssetCreate):
    with connect() as db:
        cursor = db.execute("INSERT INTO assets(project_id,asset_type,name,memory_json) VALUES(?,?,?,?)", (project_id, payload.asset_type, payload.name, json.dumps(payload.memory, ensure_ascii=False)))
    return {"id": cursor.lastrowid, **payload.model_dump()}


@app.post(f"{PREFIX}/projects/{{project_id}}/tasks", status_code=202)
def create_task(project_id: str, payload: TaskCreate):
    with connect() as db:
        if not db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone():
            raise HTTPException(404, "Project not found")
        cursor = db.execute("INSERT INTO tasks(project_id,task_type,provider,payload_json,priority,max_attempts) VALUES(?,?,?,?,?,?)", (project_id, payload.task_type, payload.provider, json.dumps(payload.payload, ensure_ascii=False), payload.priority, payload.max_attempts))
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
        db.execute("UPDATE tasks SET status='queued',progress=0,attempts=0,cancel_requested=0,error_message='',result_json='{}',available_at=CURRENT_TIMESTAMP,completed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?", (task_id,))
    return {"id": task_id, "status": "queued"}


@app.post(f"{PREFIX}/preflight")
def preflight(payload: PreflightRequest):
    return run_preflight(payload.checks)


@app.post(f"{PREFIX}/projects/{{project_id}}/bible", status_code=201)
def create_bible_version(project_id: str, payload: BibleEntityCreate):
    data = payload.model_dump()
    mark = fingerprint(payload.data, payload.reference_assets)
    with connect() as db:
        row = db.execute("SELECT COALESCE(MAX(version),0)+1 FROM bible_entities WHERE project_id=? AND entity_type=? AND entity_key=?", (project_id, payload.entity_type, payload.entity_key)).fetchone()
        version = row[0]
        cursor = db.execute("INSERT INTO bible_entities(project_id,entity_type,entity_key,name,version,state,data_json,reference_assets_json,fingerprint) VALUES(?,?,?,?,?,?,?,?,?)", (project_id, payload.entity_type, payload.entity_key, payload.name, version, payload.state, json.dumps(payload.data, ensure_ascii=False), json.dumps(payload.reference_assets, ensure_ascii=False), mark))
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


@app.post(f"{PREFIX}/gateway/{{capability}}")
async def gateway(capability: str, payload: GatewayRequest):
    if capability not in {"llm", "image", "video", "voice", "memory"}:
        raise HTTPException(404, "Unknown AI capability")
    try:
        adapter = registry.resolve(payload.provider)
    except KeyError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"capability": capability, **await adapter.invoke(payload.prompt, payload.context)}


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
    return {
        "project_id": project_id,
        "score": 86,
        "dimensions": {"character": 92, "scene": 88, "motion": 75, "lighting": 89},
        "findings": [
            {"shot": "005→006", "message": "动作跨度较大，建议增加过渡镜头", "action": "generate_transition"},
            {"shot": "012", "message": "光影与前后镜头差异较大", "action": "adjust_lighting"},
        ],
    }
