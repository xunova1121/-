import {deflateSync} from 'node:zlib';
import {pngPixels} from '../src/agent/diagramPng.js';
const digits=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];
const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let bit=0;bit<8;bit++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;};
function chunk(type,data){const label=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([label,data])));return Buffer.concat([len,label,data,sum]);}
/** 仅拼接已栅格化PNG像素，不开放SVG外链或任意命令。每图6页，数字为真实页码。 */
export async function contactSheet(blobs,start=1,{signal}={}) {
 if(!blobs.length||blobs.length>6)throw new Error('总览每张1～6页');
 const width=1600,height=Math.ceil(blobs.length/2)*490,rgb=Buffer.alloc(width*height*3,242);
 const pixel=(x,y,r,g,b)=>{const i=(y*width+x)*3;rgb[i]=r;rgb[i+1]=g;rgb[i+2]=b;};
 for(const [index,blob] of blobs.entries()){
  signal?.throwIfAborted();const source=await pngPixels(blob),left=index%2*800,top=Math.floor(index/2)*490;
  const scale=Math.min(780/source.width,450/source.height),w=Math.round(source.width*scale),h=Math.round(source.height*scale);
  const ox=left+Math.floor((800-w)/2),oy=top+30+Math.floor((450-h)/2);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const from=(Math.min(source.height-1,Math.floor(y/scale))*source.width+Math.min(source.width-1,Math.floor(x/scale)))*3;pixel(ox+x,oy+y,source.rgb[from],source.rgb[from+1],source.rgb[from+2]);}
  [...String(start+index)].forEach((n,i)=>{for(let y=0;y<5;y++)for(let x=0;x<3;x++)if(digits[Number(n)][y*3+x]==='1')for(let dy=0;dy<3;dy++)for(let dx=0;dx<3;dx++)pixel(left+12+i*14+x*3+dx,top+8+y*3+dy,20,40,70);});
 }
 const rows=Buffer.alloc((width*3+1)*height);for(let y=0;y<height;y++)rgb.copy(rows,y*(width*3+1)+1,y*width*3,(y+1)*width*3);
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 return new Blob([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))],{type:'image/png'});
}
