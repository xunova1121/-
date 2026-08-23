from typing import Any, Literal
from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    genre: str = ""
    episode_count: int = Field(default=1, ge=1, le=999)


class Project(ProjectCreate):
    id: str


class Shot(BaseModel):
    number: str
    title: str
    description: str
    duration: str
    status: str
    color: str


class ShotCreate(BaseModel):
    episode: int = Field(default=1, ge=1)
    number: str = Field(min_length=1, max_length=12)
    title: str = Field(min_length=1, max_length=120)
    description: str = ""
    duration: str = "3.0s"
    status: str = "待生成"
    color: str = "#1C2027"
    prompt: str = ""


class ShotUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    duration: str | None = None
    status: str | None = None
    prompt: str | None = None


class AssetCreate(BaseModel):
    asset_type: Literal["character", "scene", "prop", "motion"]
    name: str = Field(min_length=1, max_length=120)
    memory: dict[str, Any] = {}


class TaskCreate(BaseModel):
    task_type: Literal["llm", "image", "video", "voice", "proofread"]
    provider: str = "mock"
    payload: dict[str, Any] = {}
    priority: int = Field(default=0, ge=-100, le=100)
    max_attempts: int = Field(default=3, ge=1, le=10)


class GatewayRequest(BaseModel):
    provider: str = "mock"
    prompt: str = Field(min_length=1)
    context: dict[str, Any] = {}


class ContinuityRequest(BaseModel):
    previous: dict[str, Any]
    current: dict[str, Any]


class PipelineUpdate(BaseModel):
    status: Literal["pending", "running", "paused", "completed", "failed"]
    progress: int = Field(default=0, ge=0, le=100)
    checkpoint: dict[str, Any] = {}


class RouteUpdate(BaseModel):
    capability: str
    provider: str
    model: str


class PreflightRequest(BaseModel):
    checks: list[str] = ["database", "ffmpeg", "routes"]


class BibleEntityCreate(BaseModel):
    entity_type: Literal["world", "character", "location", "prop", "style"]
    entity_key: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=120)
    data: dict[str, Any]
    reference_assets: list[str] = []
    state: Literal["draft", "frozen"] = "draft"


class EpisodeLockRequest(BaseModel):
    episode: int = Field(ge=1)
    force: bool = False


class ContinuityContractRequest(BaseModel):
    episode: int = Field(ge=1)
    from_shot: str
    to_shot: str
    relation: Literal["new-scene", "cut", "continuous"] = "cut"
    action_state: dict[str, Any] = {}
    prop_state: dict[str, Any] = {}
    environment_state: dict[str, Any] = {}
    camera_state: dict[str, Any] = {}


class QualityReviewRequest(BaseModel):
    episode: int = Field(ge=1)
    shot_number: str
    dimensions: dict[str, int]
    findings: list[dict[str, Any]] = []
    auto_repair: bool = True


class Vector2(BaseModel):
    x: float
    y: float


class StageSubject(BaseModel):
    entity_key: str
    position: Vector2
    facing_deg: float = 0
    pose: str = "standing"


class StageLandmark(BaseModel):
    name: str
    position: Vector2 | None = None
    far_bearing_deg: float | None = None


class CameraState(BaseModel):
    position: Vector2
    target: Vector2
    lens_mm: float = Field(default=35, ge=8, le=300)
    height_m: float = Field(default=1.6, ge=0, le=20)
    movement: str = "fixed"


class SceneLayoutRequest(BaseModel):
    scene_key: str
    camera: CameraState
    subjects: list[StageSubject] = []
    landmarks: list[StageLandmark] = []
    sun_bearing_deg: float | None = None
    sun_elevation: Literal["low", "mid", "high"] = "mid"


class TransitionBoundary(BaseModel):
    shot_number: str
    scene_key: str
    action: str = ""
    action_phase: Literal["start", "middle", "end", "static"] = "static"
    screen_direction: Literal["left", "right", "center", "unknown"] = "unknown"
    camera_movement: str = "fixed"
    lighting: str = ""
    color_temperature: int | None = None
    video_path: str | None = None
    first_frame: str | None = None
    last_frame: str | None = None


class TransitionPlanRequest(BaseModel):
    episode: int = Field(ge=1)
    left: TransitionBoundary
    right: TransitionBoundary
    narrative_relation: Literal["same_action", "same_scene", "time_passage", "new_scene", "parallel"] = "same_scene"
    preferred_engine: Literal["auto", "vace", "first_last_frame", "rife", "ffmpeg"] = "auto"
    target_fps: int = Field(default=24, ge=12, le=120)
    allow_ai_bridge: bool = True


class EpisodeAutomationRequest(BaseModel):
    episode: int = Field(ge=1)
    mode: Literal["quality", "balanced", "economy"] = "balanced"
    auto_repair: bool = True
    stop_on_blocker: bool = True
