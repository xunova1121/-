import {it,expect} from 'vitest';
import {contactSheet} from '../server/presentationContactSheet.mjs';
import {pngPixels} from '../src/agent/diagramPng.js';
import {ICON_PNG} from '../src/agent/pptIcons.js';
it('真实PNG拼图保留像素，页数有界、可读回RGB，不扩展SVG许可',async()=>{
 const data=Object.values(ICON_PNG)[0].split(',').at(-1);
 const blob=new Blob([Buffer.from(data,'base64')],{type:'image/png'});
 const sheet=await contactSheet([blob,blob],7);const pixels=await pngPixels(sheet);
 expect(pixels.width).toBe(1600);expect(pixels.height).toBe(490);
 await expect(contactSheet(Array(7).fill(blob))).rejects.toThrow('1～6');
});
