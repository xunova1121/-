package com.xunova.jarvis;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.File;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
public class CrashLogTest {
    @Test public void readsOnlyBoundedTailOfLargeLog() throws Exception {
        File file=File.createTempFile("weiyang-crash",".txt");
        try{
            try(RandomAccessFile out=new RandomAccessFile(file,"rw")){out.setLength(32*1024*1024);out.seek(out.length()-100);out.write("\n最后一次异常\n".getBytes(StandardCharsets.UTF_8));}
            String text=CrashLog.tailFile(file,4096);assertTrue(text.getBytes(StandardCharsets.UTF_8).length<=4096);assertTrue(text.contains("最后一次异常"));assertEquals(32*1024*1024,file.length());
        }finally{file.delete();}
    }
}
