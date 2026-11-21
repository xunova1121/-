import {it,expect,vi} from 'vitest';
import {inspectRenderedPdf} from '../src/agent/pdfQuality.js';
import {loadPdfjs} from '../src/agent/docs.js';
vi.mock('../src/agent/docs.js',()=>({loadPdfjs:vi.fn()}));
it('转换器返回伪PDF/HTML时先拒绝，不加载页面解析器或冒充检查通过',async()=>{
 for(const body of ['%PDF-test-preview','<html>错误</html>','%PDF-0.9\n']) await expect(inspectRenderedPdf(new Blob([body]))).rejects.toMatchObject({code:'DOCUMENT_PDF_HEADER'});
 expect(loadPdfjs).not.toHaveBeenCalled();
});
it('停止信号优先，不把用户停止变成文件格式错误',async()=>{
 const controller=new AbortController();controller.abort();
 await expect(inspectRenderedPdf(new Blob(['bad']),{signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
 expect(loadPdfjs).not.toHaveBeenCalled();
});
