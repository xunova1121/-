package com.xunova.jarvis;
import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.RandomAccessFile;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** 有界异常记录，避免反复重建后重复安装处理器或整份读入过大的日志。 */
public final class CrashLog {
    private static boolean installed=false;
    private CrashLog() { }
    static File file(Context ctx){return new File(ctx.getFilesDir(),"crash.txt");}
    static String tailFile(File file,int maxBytes) throws Exception {
        if(!file.exists())return "";
        try(RandomAccessFile in=new RandomAccessFile(file,"r")){
            int count=(int)Math.min(in.length(),maxBytes);long start=in.length()-count;in.seek(start);byte[] bytes=new byte[count];in.readFully(bytes);
            String text=new String(bytes,StandardCharsets.UTF_8);
            if(start>0){int newline=text.indexOf('\n');if(newline>=0)text=text.substring(newline+1);}
            return text;
        }
    }
    static synchronized void write(Context ctx,String text){
        try{
            File f=file(ctx);
            if(f.length()>64*1024){byte[] keep=tailFile(f,8192).getBytes(StandardCharsets.UTF_8);try(FileOutputStream out=new FileOutputStream(f)){out.write(keep);}}
            try(FileOutputStream out=new FileOutputStream(f,true)){
                String time=new SimpleDateFormat("MM-dd HH:mm:ss",Locale.CHINA).format(new Date());
                out.write((time+" "+text.substring(0,Math.min(text.length(),4000))+"\n").getBytes(StandardCharsets.UTF_8));
            }
        }catch(Exception ignored){ }
    }
    static synchronized void install(Context ctx){
        if(installed)return;installed=true;
        Context app=ctx.getApplicationContext();Thread.UncaughtExceptionHandler previous=Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread,error)->{
            StringWriter writer=new StringWriter();error.printStackTrace(new PrintWriter(writer));String text=writer.toString();
            write(app,"程序出错（线程 "+thread.getName()+"）："+text.substring(0,Math.min(text.length(),1500)));
            if(previous!=null)previous.uncaughtException(thread,error);
        });
    }
    static synchronized String peek(Context ctx){try{return tailFile(file(ctx),12000);}catch(Exception e){return "读取异常记录失败："+e.getMessage();}}
    static synchronized String take(Context ctx){String text=peek(ctx);file(ctx).delete();return text.length()>3000?text.substring(text.length()-3000):text;}
}
