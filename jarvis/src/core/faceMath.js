/**
 * 人脸跟随的数学部分（需求 5.2），与 MediaPipe 解耦以便单测。
 */
const DEG = 180 / Math.PI;

/**
 * 从 MediaPipe facialTransformationMatrix（4×4，列主序）提取偏航角与俯仰角（度）。
 * 横滚角（Roll）被有意丢弃，避免智能体跟着用户歪头。
 *
 * 旋转矩阵按 Y(yaw)·X(pitch)·Z(roll) 分解：
 *   R[2][0] 在列主序里是 m[2]，R[2][2] 是 m[10]，R[1][2] 是 m[9]。
 */
export function yawPitchFromMatrix(m) {
  const r02 = m[8], r12 = m[9], r22 = m[10];
  const yaw = Math.atan2(r02, r22) * DEG;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r12))) * DEG;
  return { yaw, pitch };
}

export const LIMITS = { yaw: 45, pitch: 25 };

/**
 * 超出范围（用户完全侧身、低头看手机）时不再驱动转向，目标回到正面 0°。
 * 镜像：摄像头是自拍视角，用户向左转头，智能体应向“用户的左边”（画面右侧）看。
 */
export function followTarget({ yaw, pitch }, limits = LIMITS) {
  if (Math.abs(yaw) > limits.yaw || Math.abs(pitch) > limits.pitch) return { yaw: 0, pitch: 0, inRange: false };
  return { yaw: -yaw, pitch, inRange: true };
}

/**
 * 指数平滑：每帧向目标插值 factor（0.12）。dt 不是 1/60 时按帧数折算，
 * 让 120Hz 屏与 60Hz 屏的跟随延迟一致。
 */
export function smoothToward(current, target, factor = 0.12, dtMs = 1000 / 60) {
  const k = 1 - Math.pow(1 - factor, dtMs / (1000 / 60));
  return current + (target - current) * k;
}

/** 形态接近粒子核心（> 0.6）时停用跟随 */
export const FOLLOW_MORPH_CUTOFF = 0.6;
export function followEnabled(morph) {
  return morph <= FOLLOW_MORPH_CUTOFF;
}
