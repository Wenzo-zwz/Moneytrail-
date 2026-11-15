/* Exercises OCR-text handoff and ledger confirmation; does not run iOS OCR or Back Tap. */
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {mkdir} = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results', 'screenshots');
const PROJECT = 'https://screenshot-fixture.supabase.co';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DATE = '2026-11-16T09:10';
const MARKER = 'private-ocr-fixture-marker';
const TEXT = `支付宝\n交易提醒\n你在滴滴出行有一笔38.40元的免密/自动扣款支付，点此查看详情。\n${MARKER}`;
const clone = value => JSON.parse(JSON.stringify(value));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const empty = () => ({version:1,transactions:[],budgetCents:0,billCheckedMonths:[]});
let checks = 0;
function pass(name) { checks++; process.stdout.write(`PASS ${name}\n`); }
async function until(check, message) {
  for (let i=0;i<150;i++) { if(await check()) return; await pause(100); }
  throw new Error(message);
}
async function start(cloud, port) {
  const origin=`http://127.0.0.1:${port}`, base=origin+'/Moneytrail-/';
  let output='';
  const server=spawn(process.execPath,[path.join(ROOT,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port)],{
    cwd:ROOT,stdio:['ignore','pipe','pipe'],env:{...process.env,MONEYTRAIL_BASE_PATH:'/Moneytrail-/',VITE_SUPABASE_URL:cloud?PROJECT:'',VITE_SUPABASE_PUBLISHABLE_KEY:cloud?'sb_publishable_screenshot_fixture':'',VITE_SUPABASE_ANON_KEY:''},
  });
  server.stdout.on('data',x=>output+=x); server.stderr.on('data',x=>output+=x);
  await until(async()=>{if(server.exitCode!==null)throw Error(output);try{return /ready in/i.test(output)&&(await fetch(base)).ok;}catch{return false;}},'screenshot fixture server not ready');
  return {origin,base,server};
}
function user(id){return{id,aud:'authenticated',role:'authenticated',email:id===A?'a@example.test':'b@example.test',email_confirmed_at:'2026-10-01T00:00:00Z',app_metadata:{provider:'email'},user_metadata:{},identities:[],created_at:'2026-10-01T00:00:00Z'};}
function session(id){const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');return{access_token:`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:id,role:'authenticated',aud:'authenticated',exp:4102444800})}.${Buffer.alloc(32,5).toString('base64url')}`,refresh_token:'fixture-refresh',token_type:'bearer',expires_in:864000,user:user(id)};}
function backend(app) {
  const books=new Map([[A,{...empty(),transactions:[{id:'bank-existing',kind:'expense',source:'sms',date:DATE,amountCents:3840,merchant:'已由银行记录的消费',category:'待分类',note:''}]}],[B,empty()]]);
  const revisions=new Map([[A,1],[B,1]]);
  const requests=[],accepted=[],errors=[];
  async function attach(context){await context.route('**/*',async route=>{try{
    const request=route.request(),url=new URL(request.url());
    assert(!request.url().includes(MARKER),'OCR fragment must not be sent as a request URL');
    if(url.origin===app.origin)return route.continue();
    assert.equal(url.origin,PROJECT,'unexpected external service');
    const headers={'access-control-allow-origin':app.origin,'access-control-allow-headers':'*','access-control-allow-methods':'GET,POST,OPTIONS','content-type':'application/json'};
    const respond=(body,status=200)=>route.fulfill({status,headers,body:JSON.stringify(body)});
    if(request.method()==='OPTIONS')return respond({});
    const body=request.postData()?JSON.parse(request.postData()):null;
    assert(!request.postData()?.includes(MARKER),'raw OCR must not enter auth or ledger requests');
    let id=null;try{id=JSON.parse(Buffer.from((request.headers().authorization||'').split('.')[1],'base64url')).sub;}catch{}
    requests.push({path:url.pathname,id,body});
    if(url.pathname==='/auth/v1/token')return respond(session(body.email==='b@example.test'?B:A));
    if(url.pathname==='/auth/v1/user')return respond(user(id));
    if(url.pathname==='/auth/v1/logout')return respond({});
    assert(books.has(id),'account-bound request required');
    if(url.pathname==='/rest/v1/moneytrail_ledgers')return respond([{user_id:id,data:clone(books.get(id)),revision:revisions.get(id),updated_at:'2026-11-16T01:10:00Z'}]);
    if(url.pathname==='/rest/v1/rpc/moneytrail_is_admin')return respond(false);
    if(url.pathname==='/rest/v1/rpc/moneytrail_sms_category_rules')return respond({rules:[]});
    if(['/rest/v1/rpc/save_moneytrail_ledger','/rest/v1/rpc/save_moneytrail_ledger_with_rules'].includes(url.pathname)){
      assert.equal(body.p_expected_revision,revisions.get(id));
      revisions.set(id,revisions.get(id)+1);books.set(id,clone(body.p_data));accepted.push({id,data:clone(body.p_data)});
      return respond([{user_id:id,data:clone(body.p_data),revision:revisions.get(id),updated_at:'2026-11-16T01:11:00Z'}]);
    }
    throw Error(`unexpected fixture endpoint ${url.pathname}`);
  }catch(error){if(/Target.*closed|already handled/.test(String(error)))return;errors.push(String(error));try{await route.abort();}catch{}}});}
  return {books,requests,accepted,errors,attach};
}
async function context(browser,app,width=393,service){
  const context=await browser.newContext({viewport:{width,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai'});
  if(service)await service.attach(context);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
  return{context,page,errors};
}
async function open(page,base,text=TEXT){await page.goto(base+'#alipay-screenshot='+encodeURIComponent(text),{waitUntil:'networkidle',timeout:20000});}
async function privacy(page){
  assert.equal(new URL(page.url()).hash,'');
  const stored=await page.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)].join('\n'));
  assert(!stored.includes(MARKER),'raw OCR must not be persisted');
  const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(size.scroll<=size.width+1,'no horizontal overflow');
}
async function localBook(page){return page.evaluate(()=>JSON.parse(localStorage.getItem('moneytrail:v1')||'{"transactions":[]}'));}
async function localWorkflow(browser,app,width){const {context:ctx,page,errors}=await context(browser,app,width);try{
  await open(page,app.base);await page.getByRole('heading',{name:'滴滴出行',exact:true}).waitFor();
  assert.equal((await localBook(page)).transactions.length,0,'recognition must not write');await privacy(page);
  const text=page.getByLabel('截图提取的文字',{exact:true});assert.equal(await text.inputValue(),TEXT);
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('heading',{name:'轻点背面，截图记账',exact:true}).waitFor();
  await page.getByText('配置 iPhone 截图快捷指令',{exact:true}).click();
  assert((await page.locator('.screenshot-settings').innerText()).includes(app.base+'#alipay-screenshot='));await privacy(page);
  await page.getByRole('button',{name:'打开截图识别',exact:true}).click();assert.equal(await text.inputValue(),TEXT,'navigation must preserve the capture draft');
  await page.getByRole('tab',{name:'粘贴银行短信',exact:true}).click();await page.getByRole('tab',{name:'支付宝截图',exact:true}).click();assert.equal(await text.inputValue(),TEXT);
  await page.getByRole('button',{name:'核对并记账',exact:true}).click();let modal=page.getByRole('dialog',{name:'记下一笔',exact:true});await modal.waitFor();
  assert.equal(await modal.getByLabel('发生时间',{exact:true}).inputValue(),'','missing date stays blank');
  await modal.getByRole('button',{name:'确认保存',exact:true}).click();assert.equal((await localBook(page)).transactions.length,0);
  await modal.getByLabel('发生时间',{exact:true}).fill(DATE);await modal.getByRole('button',{name:'确认保存',exact:true}).click();
  const book=await localBook(page);assert.equal(book.transactions.length,1);assert.equal(book.transactions[0].source,'alipay');assert.equal(book.transactions[0].amountCents,3840);assert.equal(book.transactions[0].date,DATE);assert.equal(book.transactions[0].sourceRef,undefined);assert.equal(book.transactions[0].smsEvidence,undefined);
  await page.evaluate(value=>{location.hash='alipay-screenshot='+encodeURIComponent(value);},TEXT);
  await page.getByText('收到新的截图文字',{exact:true}).waitFor();assert.equal(await text.inputValue(),TEXT);
  await page.getByRole('button',{name:'使用新截图',exact:true}).click();await page.getByRole('button',{name:'核对并记账',exact:true}).click();modal=page.getByRole('dialog',{name:'记下一笔',exact:true});await modal.getByLabel('发生时间',{exact:true}).fill(DATE);
  page.once('dialog',dialog=>dialog.dismiss());await modal.getByRole('button',{name:'确认保存',exact:true}).click();assert.equal((await localBook(page)).transactions.length,1,'duplicate rejection preserves ledger');await modal.getByRole('button',{name:'取消',exact:true}).click();
  await page.evaluate(()=>{location.hash='alipay-screenshot='+encodeURIComponent('x'.repeat(16001));});await page.getByText(/截图文字过长/).first().waitFor();assert.equal(await text.inputValue(),TEXT,'invalid incoming capture preserves prior draft');
  await privacy(page);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(OUT,`capture-${width}.png`),fullPage:true});
  pass(`${width}px local handoff, private URL cleanup, automatic preview, draft preservation, required date and explicit duplicate rejection`);
}finally{await ctx.close();}}
async function cloudWorkflow(browser,app){const service=backend(app),{context:ctx,page,errors}=await context(browser,app,393,service);try{
  await open(page,app.base);await page.getByRole('button',{name:'登录我的账本',exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'','private OCR removed before login');
  await page.getByLabel('邮箱',{exact:true}).fill('a@example.test');await page.getByLabel('密码',{exact:true}).fill('Fixture-password-123!');await page.getByRole('button',{name:'登录我的账本',exact:true}).click();
  await page.getByRole('heading',{name:'滴滴出行',exact:true}).waitFor();assert.equal(service.accepted.length,0,'login and preview never save');
  await page.getByRole('button',{name:'核对并记账',exact:true}).click();const modal=page.getByRole('dialog',{name:'记下一笔',exact:true});await modal.getByLabel('发生时间',{exact:true}).fill(DATE);
  page.once('dialog',dialog=>dialog.dismiss());await modal.getByRole('button',{name:'确认保存',exact:true}).click();assert.equal(service.accepted.length,0,'cross-source duplicate can be rejected');
  page.once('dialog',dialog=>dialog.accept());await modal.getByRole('button',{name:'确认保存',exact:true}).click();await until(()=>service.accepted.length===1,'confirmed screenshot sync');
  assert.equal(service.books.get(A).transactions.length,2);assert.equal(service.books.get(B).transactions.length,0);assert.equal(service.accepted[0].id,A);assert.equal(service.books.get(A).transactions[1].source,'alipay');
  await page.getByRole('button',{name:'我的账户',exact:true}).click();await page.getByRole('button',{name:'退出登录并清除本机副本',exact:true}).click();await page.getByRole('button',{name:'登录我的账本',exact:true}).waitFor();
  await page.getByLabel('邮箱',{exact:true}).fill('b@example.test');await page.getByLabel('密码',{exact:true}).fill('Fixture-password-123!');await page.getByRole('button',{name:'登录我的账本',exact:true}).click();await page.getByRole('button',{name:'录入',exact:true}).click();await page.getByRole('tab',{name:'支付宝截图',exact:true}).click();assert.equal(await page.getByLabel('截图提取的文字',{exact:true}).inputValue(),'','capture must not cross account switch');
  await privacy(page);assert.deepEqual(errors,[]);assert.deepEqual(service.errors,[]);
  pass('account handoff survives login, waits for explicit save, checks bank duplicates, syncs only to its owner and clears on account switch');
}finally{await ctx.close();}}
(async()=>{await mkdir(OUT,{recursive:true});const browser=await chromium.launch({headless:true,...(process.env.MONEYTRAIL_CHROMIUM_PATH?{executablePath:process.env.MONEYTRAIL_CHROMIUM_PATH}:{}),args:['--no-sandbox']});try{
  const local=await start(false,5193);try{for(const width of [320,393,1440])await localWorkflow(browser,local,width);}finally{local.server.kill();}
  const cloud=await start(true,5194);try{await cloudWorkflow(browser,cloud);}finally{cloud.server.kill();}
}finally{await browser.close();}process.stdout.write(`\n${checks} screenshot browser workflows passed. Real iPhone capture, OCR and Back Tap remain to be verified.\n`);})().catch(error=>{process.stderr.write(`${error.stack||error}\n`);process.exitCode=1;});
