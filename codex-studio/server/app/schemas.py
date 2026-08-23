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
