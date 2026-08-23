import json
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .adapters import registry
from .config import settings
from .database import connect, initialize_database
from .schemas import AssetCreate, BibleEntityCreate, ContinuityContractRequest, ContinuityRequest, EpisodeLockRequest, GatewayRequest, PipelineUpdate, PreflightRequest, Project, ProjectCreate, QualityReviewRequest, RouteUpdate, Shot, ShotCreate, ShotUpdate, TaskCreate
from .continuity import analyze_pair
from .pipeline import stage_catalog
from .providers import CAPABILITIES, providers_for, public_catalog
from .preflight import run_preflight
from .quality import repair_plan, weighted_score
from .story_bible import continuity_contract, episode_snapshot, fingerprint


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost", "http://127.0.0.1"], allow_methods=["*"], allow_headers=["*"])
PREFIX = settings.api_prefix


@app.get(f"{PREFIX}/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}


@app.get(f"{PREFIX}/providers")
def provider_catalog(capability: str | None = None):
    if capability and capability not in CAPABILITIES:
        raise HTTPException(400, "Unknown capability")
    return [provider.__dict__ for provider in providers_for(capability)] if capability else public_catalog()


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


@app.delete(f"{PREFIX}/projects/{{project_id}}", status_code=204)
def delete_project(project_id: str):
    if project_id == "demo":
        raise HTTPException(400, "演示项目不可删除")
    with connect() as db:
        cursor = db.execute("DELETE FROM projects WHERE id=?", (project_id,))
        if not cursor.rowcount:
            raise HTTPException(404, "Project not found")
        for table in ("shots", "assets", "tasks", "pipeline_runs"):
            db.execute(f"DELETE FROM {table} WHERE project_id=?", (project_id,))


@app.get(f"{PREFIX}/projects/{{project_id}}/shots", response_model=list[Shot])
def list_shots(project_id: str):
    with connect() as db:
        rows = db.execute("SELECT number,title,description,duration,status,color FROM shots WHERE project_id=? ORDER BY episode,number", (project_id,)).fetchall()
    return [dict(row) for row in rows]


@app.post(f"{PREFIX}/projects/{{project_id}}/shots", status_code=201)
def create_shot(project_id: str, payload: ShotCreate):
    with connect() as db:
        exists = db.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone()
        if not exists:
            raise HTTPException(404, "Project not found")
        cursor = db.execute(
            "INSERT INTO shots(project_id,episode,number,title,description,duration,status,color,prompt) VALUES(?,?,?,?,?,?,?,?,?)",
            (project_id, payload.episode, payload.number, payload.title, payload.description, payload.duration, payload.status, payload.color, payload.prompt),
        )
    return {"id": cursor.lastrowid, **payload.model_dump()}


@app.patch(f"{PREFIX}/shots/{{shot_id}}")
def update_shot(shot_id: int, payload: ShotUpdate):
    changes = payload.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(400, "No changes")
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
        cursor = db.execute("INSERT INTO tasks(project_id,task_type,provider,payload_json) VALUES(?,?,?,?)", (project_id, payload.task_type, payload.provider, json.dumps(payload.payload, ensure_ascii=False)))
    return {"id": cursor.lastrowid, "status": "queued", **payload.model_dump()}


@app.get(f"{PREFIX}/projects/{{project_id}}/tasks")
def list_tasks(project_id: str):
    with connect() as db:
        rows = db.execute("SELECT id,task_type,provider,status,progress,payload_json,created_at FROM tasks WHERE project_id=? ORDER BY id DESC", (project_id,)).fetchall()
    return [{**dict(row), "payload": json.loads(row["payload_json"])} for row in rows]


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
