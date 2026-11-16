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
const WECHAT = '微信支付\n付款详情\n支付成功\n商户全称：示例咖啡店\n支付金额：￥18.60\n支付时间：2026年11月16日09:10';
const BILL = '13:55\n账单详情\n全部账单\n示例云南小吃店\n-28.70\n交易成功\n管理极速付款\n极速付款\n支付时间\n2026-11-16 12:32:04\n付款方式\n余额宝\n支付奖励\n立即领取15积分\n收单机构\n北京钱袋宝支付技术有限公司\n清算机构\n中国银联股份有限公司\n交易详情\n美团点餐\n已完成\n排骨米线\n共1件\n更多\n账单管理\n账单分类\n餐饮美食\n标签\n请选择';
// Preserve the phone's observed column order and OCR noise; names are synthetic.
const BILL_COLUMNS = '14:141\n账单详情\n:!!! 4G 72\n全部账单\n管理极速付款\n支付时间\n付款方式\n支付奖励\n收单机构\n清算机构\n交易详情\n英國 美团点餐＞\n示例米线\n示例云南小吃店\n-28.70\n交易成功\n极速付款\n2026-11-16 12:32:04\n余额宝＞\nv 立即领取15积分\n京示例玉支付技不有限公司\n中国银联股份有限公司\n已完成\n共1件\n更多～\n账单管理\n账单分类\n标签\n已解锁“吃顿饭“贴纸，去兑换好礼。\n餐饮美食＞\n请选择＞';
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
async function open(page,base,text=TEXT,key='screenshot'){await page.goto(base+'#'+key+'='+encodeURIComponent(text),{waitUntil:'networkidle',timeout:20000});}
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
  assert((await page.locator('.screenshot-settings').innerText()).includes(app.base+'#screenshot='));await privacy(page);
  await page.getByRole('button',{name:'打开截图识别',exact:true}).click();assert.equal(await text.inputValue(),TEXT,'navigation must preserve the capture draft');
  await page.getByRole('tab',{name:'粘贴银行短信',exact:true}).click();await page.getByRole('tab',{name:'截图记账',exact:true}).click();assert.equal(await text.inputValue(),TEXT);
  await page.getByRole('button',{name:'核对并记账',exact:true}).click();let modal=page.getByRole('dialog',{name:'记下一笔',exact:true});await modal.waitFor();
  assert.equal(await modal.getByLabel('发生时间',{exact:true}).inputValue(),'','missing date stays blank');
  await modal.getByRole('button',{name:'确认保存',exact:true}).click();assert.equal((await localBook(page)).transactions.length,0);
  await modal.getByLabel('发生时间',{exact:true}).fill(DATE);await modal.getByRole('button',{name:'确认保存',exact:true}).click();
  const book=await localBook(page);assert.equal(book.transactions.length,1);assert.equal(book.transactions[0].source,'alipay');assert.equal(book.transactions[0].amountCents,3840);assert.equal(book.transactions[0].date,DATE);assert.equal(book.transactions[0].sourceRef,undefined);assert.equal(book.transactions[0].smsEvidence,undefined);
  await page.evaluate(value=>{location.hash='screenshot='+encodeURIComponent(value);},TEXT);
  await page.getByText('收到新的截图文字',{exact:true}).waitFor();assert.equal(await text.inputValue(),TEXT);
  await page.getByRole('button',{name:'使用新截图',exact:true}).click();await page.getByRole('button',{name:'核对并记账',exact:true}).click();modal=page.getByRole('dialog',{name:'记下一笔',exact:true});await modal.getByLabel('发生时间',{exact:true}).fill(DATE);
  page.once('dialog',dialog=>dialog.dismiss());await modal.getByRole('button',{name:'确认保存',exact:true}).click();assert.equal((await localBook(page)).transactions.length,1,'duplicate rejection preserves ledger');await modal.getByRole('button',{name:'取消',exact:true}).click();
  await page.evaluate(()=>{location.hash='screenshot='+encodeURIComponent('x'.repeat(16001));});await page.getByText(/截图文字过长/).first().waitFor();assert.equal(await text.inputValue(),TEXT,'invalid incoming capture preserves prior draft');
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
  await page.evaluate(value=>{location.hash='screenshot='+encodeURIComponent(value);},WECHAT);
  await page.getByRole('button',{name:'使用新截图',exact:true}).click();
  assert.equal(await page.getByLabel('支付来源：示例咖啡店',{exact:true}).inputValue(),'wechat');
  await page.getByRole('button',{name:'核对并记账',exact:true}).click();
  const wechatModal=page.getByRole('dialog',{name:'记下一笔',exact:true});assert.equal(await wechatModal.getByLabel('发生时间',{exact:true}).inputValue(),DATE);
  await wechatModal.getByRole('button',{name:'确认保存',exact:true}).click();await until(()=>service.accepted.length===2,'WeChat screenshot sync');
  assert.equal(service.books.get(A).transactions[2].source,'wechat');assert.equal(service.books.get(B).transactions.length,0);
  await page.getByRole('button',{name:'我的账户',exact:true}).click();await page.getByRole('button',{name:'退出登录并清除本机副本',exact:true}).click();await page.getByRole('button',{name:'登录我的账本',exact:true}).waitFor();
  await page.getByLabel('邮箱',{exact:true}).fill('b@example.test');await page.getByLabel('密码',{exact:true}).fill('Fixture-password-123!');await page.getByRole('button',{name:'登录我的账本',exact:true}).click();await page.getByRole('button',{name:'录入',exact:true}).click();await page.getByRole('tab',{name:'截图记账',exact:true}).click();assert.equal(await page.getByLabel('截图提取的文字',{exact:true}).inputValue(),'','capture must not cross account switch');
  await privacy(page);assert.deepEqual(errors,[]);assert.deepEqual(service.errors,[]);
  pass('account handoff survives login, confirms Alipay/WeChat sources, checks bank duplicates, syncs only to its owner and clears on account switch');
}finally{await ctx.close();}}
async function platformWorkflow(browser,app,source,override){const {context:ctx,page,errors}=await context(browser,app,393);try{
  const text=source==='wechat'?WECHAT:WECHAT.replace('微信支付\n','');
  // A legacy Alipay-named link must carry WeChat text without assigning Alipay.
  await open(page,app.base,text,source==='wechat'?'alipay-screenshot':'screenshot');
  await page.getByRole('heading',{name:'示例咖啡店',exact:true}).waitFor();
  const selected=page.getByLabel('支付来源：示例咖啡店',{exact:true});assert.equal(await selected.inputValue(),source);
  if(override)await selected.selectOption(override);
  assert.equal((await localBook(page)).transactions.length,0);
  await page.getByRole('button',{name:'核对并记账',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'记下一笔',exact:true});assert.equal(await modal.getByLabel('发生时间',{exact:true}).inputValue(),DATE);
  await modal.getByRole('button',{name:'确认保存',exact:true}).click();
  const book=await localBook(page);assert.equal(book.transactions.length,1);assert.equal(book.transactions[0].source,override||source);assert.equal(book.transactions[0].note,'截图识别');
  await privacy(page);assert.deepEqual(errors,[]);
  pass(`payment source ${source}${override?' explicitly corrected to '+override:''}, including legacy-link compatibility, is preserved on save`);
}finally{await ctx.close();}}
async function billWorkflow(browser,app,columns=false,missingHeading=false){const {context:ctx,page,errors}=await context(browser,app,393);try{
  const input=columns?BILL_COLUMNS:BILL;
  await open(page,app.base,missingHeading?input.replace('14:141\n账单详情\n:!!! 4G 72','14:56\n<'):input);
  await page.getByRole('heading',{name:'示例云南小吃店',exact:true}).waitFor();
  await until(()=>page.getByRole('heading',{name:'截图识别结果 · 1 笔待核对',exact:true}).evaluate(el=>el===document.activeElement),'incoming screenshot should focus its review result');
  assert.equal(await page.getByLabel('截图提取的文字',{exact:true}).isVisible(),false,'raw OCR is collapsed after automatic recognition');
  const source=page.getByLabel('支付来源：示例云南小吃店',{exact:true});
  assert.equal(await source.inputValue(),'manual','an unbranded bill needs source confirmation');
  assert.equal((await localBook(page)).transactions.length,0,'a real bill layout must remain a preview');
  await source.selectOption('alipay');
  await page.getByRole('button',{name:'核对并记账',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'记下一笔',exact:true});
  assert.equal(await modal.getByLabel('发生时间',{exact:true}).inputValue(),'2026-11-16T12:32');
  assert.equal(await modal.getByLabel('金额（元）',{exact:true}).inputValue(),'28.70');
  await modal.getByRole('button',{name:'确认保存',exact:true}).click();
  const book=await localBook(page);assert.equal(book.transactions.length,1);
  assert.equal(book.transactions[0].merchant,'示例云南小吃店');assert.equal(book.transactions[0].amountCents,2870);
  assert.equal(book.transactions[0].source,'alipay');assert.equal(book.transactions[0].date,'2026-11-16T12:32');
  await privacy(page);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(OUT,missingHeading?'alipay-missing-heading.png':columns?'alipay-column-bill.png':'alipay-detail-bill.png'),fullPage:true,animations:'disabled'});
  pass(`${missingHeading?'a real OCR capture with no page heading':columns?'actual phone column order and OCR noise':'unlabeled domestic bill layout'} previews the exact amount and payment time with raw text collapsed, requires source confirmation and saves only after review`);
}finally{await ctx.close();}}
async function editWorkflow(browser,app){const {context:ctx,page,errors}=await context(browser,app,393);try{
  await open(page,app.base,'账单详情\n全部账单\n支付时间\n付款方式');
  await page.getByText('暂未识别出可核对的账目',{exact:true}).waitFor();
  const text=page.getByLabel('截图提取的文字',{exact:true});assert.equal(await text.isVisible(),false);
  await page.getByRole('button',{name:'检查识别文字',exact:true}).click();
  await text.fill(WECHAT);await page.getByRole('button',{name:'识别截图文字',exact:true}).click();
  await page.getByRole('heading',{name:'示例咖啡店',exact:true}).waitFor();
  assert.equal(await text.isVisible(),false,'successful correction returns focus to candidate review');
  assert.equal((await localBook(page)).transactions.length,0);await privacy(page);assert.deepEqual(errors,[]);
  pass('an unsuccessful capture shows an actionable error, can be edited and recognized, and keeps raw text out of the candidate review');
}finally{await ctx.close();}}
async function incompleteMerchantWorkflow(browser,app){const {context:ctx,page,errors}=await context(browser,app,393);try{
  await open(page,app.base,'微信支付\n支付成功\n-28.70\n支付时间：2026-11-16 12:32:04');
  await page.getByRole('heading',{name:'商户待填写',exact:true}).waitFor();
  assert.equal(await page.getByLabel('支付来源：第 1 笔待核对账目',{exact:true}).inputValue(),'wechat');
  assert.equal((await localBook(page)).transactions.length,0);
  await page.getByRole('button',{name:'核对并记账',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'记下一笔',exact:true});
  assert.equal(await modal.getByLabel('商户 / 对方',{exact:true}).inputValue(),'');
  assert.equal(await modal.getByLabel('金额（元）',{exact:true}).inputValue(),'28.70');
  assert.equal(await modal.getByLabel('发生时间',{exact:true}).inputValue(),'2026-11-16T12:32');
  await modal.getByRole('button',{name:'确认保存',exact:true}).click();assert.equal((await localBook(page)).transactions.length,0,'missing merchant must block saving');
  await modal.getByLabel('商户 / 对方',{exact:true}).fill('示例补填商户');await modal.getByRole('button',{name:'确认保存',exact:true}).click();
  const book=await localBook(page);assert.equal(book.transactions.length,1);assert.equal(book.transactions[0].merchant,'示例补填商户');assert.equal(book.transactions[0].amountCents,2870);
  await privacy(page);assert.deepEqual(errors,[]);pass('a clear negative payment preserves its amount and date with merchant blank, and requires the user to supply a merchant before saving');
}finally{await ctx.close();}}
async function amountHintWorkflow(browser,app){const {context:ctx,page,errors}=await context(browser,app,393);try{
  await open(page,app.base,'14:56\n-28.70');
  await page.getByRole('heading',{name:'仅识别到金额',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'核对并记账',exact:true}).count(),0,'unconfirmed direction is not a normal expense candidate');
  assert.equal((await localBook(page)).transactions.length,0);
  const source=page.getByLabel('支付来源：待确认金额',{exact:true});assert.equal(await source.inputValue(),'manual');await source.selectOption('alipay');
  await page.getByRole('button',{name:'确认是支出并补全',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'记下一笔',exact:true});
  assert.equal(await modal.getByLabel('金额（元）',{exact:true}).inputValue(),'28.70');
  assert.equal(await modal.getByLabel('商户 / 对方',{exact:true}).inputValue(),'');assert.equal(await modal.getByLabel('发生时间',{exact:true}).inputValue(),'');
  await modal.getByRole('button',{name:'确认保存',exact:true}).click();assert.equal((await localBook(page)).transactions.length,0);
  await modal.getByLabel('商户 / 对方',{exact:true}).fill('人工核对的示例支出');await modal.getByLabel('发生时间',{exact:true}).fill(DATE);
  await modal.getByRole('button',{name:'确认保存',exact:true}).click();const book=await localBook(page);assert.equal(book.transactions.length,1);assert.equal(book.transactions[0].kind,'expense');assert.equal(book.transactions[0].source,'alipay');assert.equal(book.transactions[0].amountCents,2870);
  await privacy(page);assert.deepEqual(errors,[]);pass('a negative amount alone remains an amount hint, needs explicit expense confirmation, and still requires merchant and date before saving');
}finally{await ctx.close();}}
async function balanceWorkflow(browser,app){const {context:ctx,page,errors}=await context(browser,app,393);try{
  await open(page,app.base,'账户余额\n-28.70\n交易成功\n付款方式\n余额宝');
  await page.getByRole('heading',{name:'暂未识别出可核对的账目',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'核对并记账',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'确认是支出并补全',exact:true}).count(),0);
  assert.equal((await localBook(page)).transactions.length,0);await privacy(page);assert.deepEqual(errors,[]);pass('a negative account balance cannot become an expense candidate or an adoptable amount hint');
}finally{await ctx.close();}}
(async()=>{await mkdir(OUT,{recursive:true});const browser=await chromium.launch({headless:true,...(process.env.MONEYTRAIL_CHROMIUM_PATH?{executablePath:process.env.MONEYTRAIL_CHROMIUM_PATH}:{}),args:['--no-sandbox']});try{
  const local=await start(false,5193);try{for(const width of [320,393,1440])await localWorkflow(browser,local,width);await platformWorkflow(browser,local,'wechat');await platformWorkflow(browser,local,'manual');await platformWorkflow(browser,local,'manual','wechat');await billWorkflow(browser,local);await billWorkflow(browser,local,true);await billWorkflow(browser,local,true,true);await editWorkflow(browser,local);await incompleteMerchantWorkflow(browser,local);await amountHintWorkflow(browser,local);await balanceWorkflow(browser,local);}finally{local.server.kill();}
  const cloud=await start(true,5194);try{await cloudWorkflow(browser,cloud);}finally{cloud.server.kill();}
}finally{await browser.close();}process.stdout.write(`\n${checks} screenshot browser workflows passed. Browser fixtures do not run iPhone capture or OCR; final save on the user's device still needs verification.\n`);})().catch(error=>{process.stderr.write(`${error.stack||error}\n`);process.exitCode=1;});
