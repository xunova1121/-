package com.xunova.jarvis;

/** 不依赖 Android 的绘制策略，隐藏时停帧、闲置降帧；动作均来自本地素材。 */
final class CompanionMotion {
    static int frameDelay(boolean visible,boolean safe,long idleMs,boolean reacting){return !visible?-1:safe?250:reacting?66:idleMs>45000?500:160;}
    static int pose(int taps){return taps%3==0?7:taps%2==0?6:11;}
    static boolean hit(float x,float y,float cx,float cy,float size){return Math.abs(x-cx)<=size*.48f&&Math.abs(y-cy)<=size*.5f;}
    static boolean tap(float downX,float downY,float x,float y,float density){return Math.hypot(x-downX,y-downY)<18*Math.max(1,density);}
}
