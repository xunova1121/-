package com.xunova.jarvis;

import android.service.wallpaper.WallpaperService;
import android.graphics.*;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.content.Intent;

/** 原生二维动态壁纸：无 WebView、无网络、无麦克风；不可见即停止绘制。 */
public class CompanionWallpaperService extends WallpaperService {
    @Override public Engine onCreateEngine(){return new CompanionEngine();}
    final class CompanionEngine extends Engine {
        final Handler handler=new Handler(Looper.getMainLooper());
        final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG|Paint.FILTER_BITMAP_FLAG);
        final Runnable draw=this::frame;
        Bitmap atlas;boolean visible=false,surface=false,destroyed=false;
        long touched=0,lastAction=SystemClock.uptimeMillis();int taps=0;
        float width=1,height=1,cx,cy,size,downX,downY;String caption="你一叫，我就在呀";
        @Override public void onCreate(SurfaceHolder holder){super.onCreate(holder);setTouchEventsEnabled(true);try(java.io.InputStream stream=getAssets().open("companion-atlas.png")){atlas=BitmapFactory.decodeStream(stream);}catch(Exception error){CrashLog.write(CompanionWallpaperService.this,"陪伴壁纸素材："+error.getMessage());}}
        @Override public void onSurfaceChanged(SurfaceHolder holder,int format,int w,int h){super.onSurfaceChanged(holder,format,w,h);width=w;height=h;cx=w*.56f;cy=h*.44f;size=Math.min(w*.72f,h*.35f);surface=true;schedule();}
        @Override public void onSurfaceDestroyed(SurfaceHolder holder){surface=false;handler.removeCallbacks(draw);super.onSurfaceDestroyed(holder);}
        @Override public void onVisibilityChanged(boolean on){visible=on;schedule();}
        void schedule(){handler.removeCallbacks(draw);if(visible&&surface&&!destroyed)handler.post(draw);}
        float dp(float n){return n*getResources().getDisplayMetrics().density;}
        void text(Canvas c,String text,float x,float y,float font,int color){paint.setShader(null);paint.setStyle(Paint.Style.FILL);paint.setColor(color);paint.setTextSize(font);paint.setTypeface(Typeface.create("sans-serif",Typeface.NORMAL));paint.setTextAlign(Paint.Align.CENTER);c.drawText(text,x,y,paint);}
        void frame(){
            if(!visible||!surface||destroyed)return;
            Canvas c=null;long now=SystemClock.uptimeMillis(),idle=now-lastAction;boolean reacting=now-touched<1100,safe=MainActivity.safeDisplay(CompanionWallpaperService.this);
            try {
                c=getSurfaceHolder().lockCanvas();if(c==null)return;
                paint.setShader(new LinearGradient(0,0,0,height,new int[]{0xff061325,0xff13344c,0xff081629},null,Shader.TileMode.CLAMP));paint.setStyle(Paint.Style.FILL);c.drawRect(0,0,width,height,paint);paint.setShader(null);
                // 原生远山与湖面，留出桌面图标的阅读空间。
                paint.setColor(0xff152c42);Path mountains=new Path();mountains.moveTo(0,height*.72f);mountains.lineTo(width*.15f,height*.62f);mountains.lineTo(width*.32f,height*.73f);mountains.lineTo(width*.65f,height*.68f);mountains.lineTo(width*.85f,height*.6f);mountains.lineTo(width,height*.7f);mountains.lineTo(width,height);mountains.lineTo(0,height);mountains.close();c.drawPath(mountains,paint);
                paint.setColor(0xff0a1d30);c.drawRect(0,height*.76f,width,height,paint);
                float breathe=safe?0:(float)Math.sin(now/1600d)*dp(3),bottom=cy+size*.54f;
                paint.setColor(0x994cc9ee);paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(dp(1));c.drawOval(cx-size*.42f,bottom,cx+size*.42f,bottom+dp(15),paint);c.drawOval(cx-size*.30f,bottom+dp(4),cx+size*.30f,bottom+dp(11),paint);paint.setStyle(Paint.Style.FILL);
                int pose=idle>45000?8:reacting?CompanionMotion.pose(taps):((now%5500)>5200?1:0);
                if(atlas!=null){int cellX=atlas.getWidth()/4,cellY=atlas.getHeight()/3;Rect source=new Rect((pose%4)*cellX,(pose/4)*cellY,(pose%4+1)*cellX,(pose/4+1)*cellY);RectF target=new RectF(cx-size/2,cy-size/2+breathe,cx+size/2,cy+size/2+breathe);paint.setColor(Color.WHITE);c.drawBitmap(atlas,source,target,paint);}
                if(reacting&&!safe){float progress=(now-touched)/1100f;paint.setColor(Color.argb((int)(190*(1-progress)),255,224,160));paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(dp(1));c.drawCircle(cx,cy-size*.32f,size*(.08f+progress*.22f),paint);paint.setStyle(Paint.Style.FILL);}
                text(c,idle>45000?"我眯一会，有事就叫我呀":caption,cx,cy-size*.6f,dp(14),0xffdeefff);
                text(c,"未央 · 全息陪伴",width*.5f,Math.max(dp(68),height*.10f),dp(15),0xffbed7e8);
                paint.setColor(0xbb17334d);RectF chat=new RectF(width*.22f,height*.86f,width*.78f,height*.86f+dp(46));c.drawRoundRect(chat,dp(23),dp(23),paint);text(c,"和未央聊一会 ↗",width*.5f,chat.centerY()+dp(5),dp(14),0xffdeefff);
            }catch(Exception error){handler.removeCallbacks(draw);CrashLog.write(CompanionWallpaperService.this,"陪伴壁纸绘制："+error.getClass().getSimpleName());}
            finally{if(c!=null)try{getSurfaceHolder().unlockCanvasAndPost(c);}catch(Exception ignored){}}
            int delay=CompanionMotion.frameDelay(visible,safe,idle,reacting);if(delay>0&&!destroyed)handler.postDelayed(draw,delay);
        }
        @Override public void onTouchEvent(MotionEvent e){
            if(e.getActionMasked()==MotionEvent.ACTION_DOWN){downX=e.getX();downY=e.getY();}
            else if(e.getActionMasked()==MotionEvent.ACTION_UP&&CompanionMotion.tap(downX,downY,e.getX(),e.getY(),getResources().getDisplayMetrics().density)){
                float x=e.getX(),y=e.getY();
                if(CompanionMotion.hit(x,y,cx,cy,size)){taps++;touched=lastAction=SystemClock.uptimeMillis();caption=taps%3==0?"嘿嘿，被你摸得害羞啦":"摸摸头，今天也要开心呀";schedule();}
                else if(x>width*.22f&&x<width*.78f&&y>height*.86f&&y<height*.86f+dp(46)&&!isPreview()){
                    try{Intent intent=new Intent(CompanionWallpaperService.this,MainActivity.class).putExtra("openHologram",true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP);startActivity(intent);}catch(Exception error){caption="请打开未央，进入全息陪伴";lastAction=SystemClock.uptimeMillis();schedule();}
                }
            }
            super.onTouchEvent(e);
        }
        @Override public void onDestroy(){destroyed=true;handler.removeCallbacks(draw);if(atlas!=null){atlas.recycle();atlas=null;}super.onDestroy();}
    }
}
