from typing import Any, Literal
from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    genre: str = ""
    episode_count: int = Field(default=1, ge=1, le=999)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    genre: str | None = Field(default=None, max_length=80)
    episode_count: int | None = Field(default=None, ge=1, le=999)


class Project(ProjectCreate):
    id: str


class ScriptUpsert(BaseModel):
    title: str = Field(default="", max_length=200)
    source_name: str = Field(default="", max_length=260)
    source_text: str = Field(min_length=1)


class StoryboardGenerateRequest(BaseModel):
    replace_existing: bool = True


class Shot(BaseModel):
    id: int
    episode: int
    scene_id: int | None = None
    sequence: int = 0
    number: str
    title: str
    description: str
    duration: str
    status: str
    color: str
    prompt: str = ""
    shot_type: str = "中景"
    camera: str = "固定"
    action: str = ""
    dialogue: str = ""
    characters: list[str] = []
    continuity: dict[str, Any] = {}


class ShotCreate(BaseModel):
    episode: int = Field(default=1, ge=1)
    number: str = Field(min_length=1, max_length=12)
    title: str = Field(min_length=1, max_length=120)
    description: str = ""
    duration: str = "3.0s"
    status: str = "待生成"
    color: str = "#1C2027"
    prompt: str = ""
    scene_id: int | None = None
    sequence: int = 0
    shot_type: str = "中景"
    camera: str = "固定"
    action: str = ""
    dialogue: str = ""
    characters: list[str] = []
    continuity: dict[str, Any] = {}


class ShotUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    duration: str | None = None
    status: str | None = None
    prompt: str | None = None
    shot_type: str | None = None
    camera: str | None = None
    action: str | None = None
    dialogue: str | None = None
    characters: list[str] | None = None
    continuity: dict[str, Any] | None = None


class AssetCreate(BaseModel):
    asset_type: Literal["character", "scene", "prop", "motion"]
    name: str = Field(min_length=1, max_length=120)
    memory: dict[str, Any] = {}


class AssetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    asset_type: Literal["character", "scene", "prop", "image", "video", "voice", "music", "subtitle", "motion"] | None = None
    episode: int | None = Field(default=None, ge=1)
    shot_id: int | None = None
    status: str | None = None
    memory: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None


class AssetImportRequest(BaseModel):
    source_path: str = Field(min_length=1)
    asset_type: Literal["character", "scene", "prop", "image", "video", "voice", "music", "subtitle", "motion"]
    name: str = Field(default="", max_length=120)
    episode: int = Field(default=1, ge=1)
    shot_id: int | None = None
    copy_into_project: bool = True
    memory: dict[str, Any] = {}


class ShotGenerationRequest(BaseModel):
    shot_id: int
    task_type: Literal["image", "video", "voice"]
    provider: str
    prompt: str = Field(min_length=1, max_length=32000)
    model: str | None = None
    reference_asset_ids: list[int] = []
    options: dict[str, Any] = {}


class TimelineClipCreate(BaseModel):
    episode: int = Field(default=1, ge=1)
    track: Literal["V1", "V2", "A1", "A2", "T1"] = "V1"
    asset_id: int | None = None
    source_path: str = Field(min_length=1)
    title: str = ""
    trim_in: float = Field(default=0, ge=0)
    trim_out: float = Field(default=0, ge=0)
    duration: float = Field(default=0, ge=0)
    transition: Literal["cut", "dissolve", "fade_black"] = "cut"
    transition_duration: float = Field(default=0.4, ge=0, le=3)
    volume: float = Field(default=1, ge=0, le=4)
    metadata: dict[str, Any] = {}


class TimelineClipUpdate(BaseModel):
    position: int | None = Field(default=None, ge=0)
    track: Literal["V1", "V2", "A1", "A2", "T1"] | None = None
    title: str | None = None
    trim_in: float | None = Field(default=None, ge=0)
    trim_out: float | None = Field(default=None, ge=0)
    duration: float | None = Field(default=None, ge=0)
    transition: Literal["cut", "dissolve", "fade_black"] | None = None
    transition_duration: float | None = Field(default=None, ge=0, le=3)
    volume: float | None = Field(default=None, ge=0, le=4)


class TimelineReorderRequest(BaseModel):
    clip_ids: list[int]


class TimelineExportRequest(BaseModel):
    episode: int = Field(default=1, ge=1)
    width: int = Field(default=1920, ge=320, le=3840)
    height: int = Field(default=1080, ge=240, le=2160)
    fps: int = Field(default=24, ge=12, le=60)
    quality: Literal["draft", "standard", "high"] = "high"
    burn_subtitles: bool = True
    output_name: str = Field(default="final.mp4", min_length=1, max_length=120)


class TaskCreate(BaseModel):
    task_type: Literal["llm", "image", "video", "voice", "proofread", "transition_render", "timeline_export"]
    provider: str = "mock"
    payload: dict[str, Any] = {}
    priority: int = Field(default=0, ge=-100, le=100)
    max_attempts: int = Field(default=3, ge=1, le=10)


class GatewayRequest(BaseModel):
    provider: str = "mock"
    prompt: str = Field(min_length=1)
    context: dict[str, Any] = {}


class ProviderConfigUpdate(BaseModel):
    base_url: str = Field(min_length=8, max_length=500)
    model: str = Field(min_length=1, max_length=160)
    api_key: str | None = Field(default=None, min_length=8, max_length=500)


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


class TransitionRenderRequest(BaseModel):
    left_path: str = Field(min_length=1)
    right_path: str = Field(min_length=1)
    method: Literal["cut", "match_cut", "dissolve", "fade_black"] = "dissolve"
    duration_seconds: float = Field(default=0.5, gt=0, le=3)
    target_fps: int = Field(default=24, ge=12, le=60)
    width: int = Field(default=1280, ge=320, le=3840)
    height: int = Field(default=720, ge=240, le=2160)
    preserve_audio: bool = True


class EpisodeAutomationRequest(BaseModel):
    episode: int = Field(ge=1)
    mode: Literal["quality", "balanced", "economy"] = "balanced"
    auto_repair: bool = True
    stop_on_blocker: bool = True


class AutomationStartRequest(BaseModel):
    episode: int = Field(default=1, ge=1)
    mode: Literal["quality", "balanced", "economy"] = "balanced"
    image_provider: str = "openai"
    image_model: str = "gpt-image-2"
    video_provider: str = "dashscope"
    video_model: str = "wan2.7-i2v-2026-04-25"
    voice_provider: str | None = "openai"
    voice_model: str = "gpt-4o-mini-tts"
    quality_provider: str | None = None
    output_name: str = "自动成片.mp4"
    width: int = Field(default=1920, ge=320, le=3840)
    height: int = Field(default=1080, ge=240, le=2160)
    fps: int = Field(default=24, ge=12, le=60)
    quality: Literal["draft", "standard", "high"] = "high"
    auto_freeze_bible: bool = True
    generate_images: bool = True
    generate_voice: bool = True
    generate_bridges: bool = True
    auto_repair: bool = True
    stop_on_blocker: bool = True
