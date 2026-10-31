/** Edge Read Aloud protocol v2. Constants/protocol verified against
 * https://github.com/rany2/edge-tts/blob/master/src/edge_tts/drm.py .
 * Independent compact implementation: ordinary SHA-256 compression plus the
 * protocol's partial first block and CS64 checksum. No SDK / network required.
 */
export const EDGE_GEC_VERSION = '2-143.0.3650.75';
const rot = (x, n) => (x >>> n) | (x << (32 - n));
const small0 = x => (rot(x,7) ^ rot(x,18) ^ (x >>> 3)) >>> 0;
const small1 = x => (rot(x,17) ^ rot(x,19) ^ (x >>> 10)) >>> 0;
const swap = x => ((x << 16) | (x >>> 16)) >>> 0;
const mul = (a,b) => Math.imul(a,b) >>> 0;
const hex = bytes => Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
function expand(w, start = 16) {
  for(let i=start;i<64;i++) w[i]=(small1(w[i-2])+w[i-7]+small0(w[i-15])+w[i-16])>>>0;
}
function compress(state,w,first=0) {
  let [a,b,c,d,e,f,g,h]=state;
  for(let i=first;i<64;i++) {
    const k=first===14 && i===14 ? 0xC9DC06A7 : K[i];
    const t1=(h+(rot(e,6)^rot(e,11)^rot(e,25))+((e&f)^(~e&g))+k+w[i])>>>0;
    const t2=((rot(a,2)^rot(a,13)^rot(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
    [a,b,c,d,e,f,g,h]=[(t1+t2)>>>0,a,b,c,(d+t1)>>>0,e,f,g];
  }
  return [a,b,c,d,e,f,g,h];
}
function digest(data) {
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
  const w=Array(64).fill(0);
  w[14]=(data[0]<<16)|(data[1]<<8)|data[2]; w[15]=view.getUint32(3);
  for(let i=16;i<30;i++) {
    let n=PREFIX[i-16];
    if(i-2>=14)n+=(small1(w[i-2])^(i===16?0x000B92C0:0))>>>0;
    if(i-7>=14)n+=w[i-7];
    if(i-15>=14)n+=(small0(w[i-15])^(i===29?0x059C0B80:0))>>>0;
    w[i]=n>>>0;
  }
  w[30]=(small1(w[28])+w[23]+small0(w[15])+w[14]+0xC9DC06A7-K[14])>>>0;
  expand(w,31);
  let state=compress(SEED,w,14).map((n,i)=>(n+IV[i])>>>0);
  const length=57+data.length;
  const padded=new Uint8Array(data.length-7+1+((55-length)%64+64)%64+8);
  padded.set(data.subarray(7)); padded[data.length-7]=128;
  const pv=new DataView(padded.buffer); pv.setBigUint64(padded.length-8,BigInt(length*8));
  for(let off=0;off<padded.length;off+=64) {
    const words=Array.from({length:16},(_,i)=>pv.getUint32(off+i*4)); expand(words);
    state=compress(state,words).map((n,i)=>(n+state[i])>>>0);
  }
  const out=new Uint8Array(32), ov=new DataView(out.buffer);
  state.forEach((n,i)=>ov.setUint32(i*4,n)); return out;
}
function checksum(data,sha) {
  const dv=new DataView(sha.buffer), keys=[dv.getUint32(0,true)|1,dv.getUint32(4,true)|1];
  const factors=keys.map(k=>mul(k,0x82893933));
  const pairs=COEFF.map(([a,b],i)=>[mul(a,factors[i%2]),b]);
  const bytes=new Uint8Array(Math.ceil((data.length+1)/8)*8); bytes.set(data,1);
  const words=new DataView(bytes.buffer);
  for(let i=0;i<bytes.length/4;i++) {
    const word=words.getUint32(i*4,true);
    pairs.push([(mul(word,keys[i%2])+(i===0?mul(0xF2F90B1A,factors[0]):0))>>>0,
      (mul(swap(word),i%2?0xC31713DB:0xEF0569FB)+(i===0?0x0B1A0000:0))>>>0]);
  }
  let sum=0,last=0,state=0,acc=0;
  for(let i=0;i<pairs.length;i+=2) {
    const [x,ox]=pairs[i], [y,oy]=pairs[i+1];
    let q=mul(swap((ox+x)>>>0),0x76F50F34);
    sum=(sum+mul(swap(q),0xC3EFEA97)+q)>>>0;
    q=mul(swap((oy+y)>>>0),0x1881CE3C);
    last=(mul(swap(q),0x35BD1EC9)+q)>>>0; sum=(sum+last)>>>0;
    state=(mul(state,keys[0])+x)>>>0;
    for(const c of [0xCF98B111,0x87085B9F,0x12CEB96D,0x257E1D83])state=mul(swap(state),c);
    acc=(acc+state)>>>0;
    state=(mul(state,keys[1])+y)>>>0;
    for(const c of [0xA27416F5,0xD38396FF,0x7C932B89,0xBFA49F69])state=mul(swap(state),c);
    acc=(acc+state)>>>0;
  }
  const out=new Uint8Array(8), ov=new DataView(out.buffer);
  ov.setUint32(0,(last^state)>>>0,true); ov.setUint32(4,(sum^acc)>>>0,true); return out;
}
export function secMsGec(nowMs = Date.now()) {
  const seconds=Math.floor(nowMs/1000)+11644473600;
  const ticks=BigInt(seconds-seconds%300)*10000000n;
  const data=new TextEncoder().encode(`${ticks}6A5AA1D4EAFF4E9FB37E23D68491D6F4`);
  const sha=digest(data); return `${hex(checksum(data,sha))}-${hex(sha)}`;
}
const IV = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225];
const SEED = [4255104674, 2435071207, 3192492180, 3442351626, 1811967817, 79508907, 4272990180, 66059218];
const PREFIX = [3945054110, 358115615, 2696978146, 217723578, 2787307148, 3520959633, 3235718560, 4192668342, 4039316851, 1884868174, 1904797190, 15051571, 3529027680, 1920361828];
const K = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298];
const COEFF = [[3895366065, 3005677776], [1155409094, 2296378653], [1005282748, 693190712], [3365689651, 3005795295], [2367603217, 3557143765], [827258325, 652566332], [3911487921, 1618477510], [4037392853, 2192753147], [101076211, 4199654362], [3665427040, 545047652], [3201434976, 1010595059], [2314848760, 3536931681], [905590982, 3137643201], [3410617286, 3311559015]];
