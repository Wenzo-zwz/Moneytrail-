/* Real SDK + intercepted service fixtures. Does not execute the Apple shortcut. */
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {mkdir} = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const ROOT=path.resolve(__dirname,'..'), OUT=path.join(ROOT,'test-results','sms-install');
const OFFICIAL='https://ojcgabicpjipwpvwolzn.supabase.co', CUSTOM='https://custom-install-fixture.supabase.co';
const INSTALL='https://www.icloud.com/shortcuts/86d33de8ff704d6581c173b82f3f4f21';
const THREE_BANK_SOURCE='/Moneytrail-/shortcuts/moneytrail-three-bank-v1.unsigned.plist';
const THREE_BANKS=[{code:'abc',name:'农业银行'},{code:'boc',name:'中国银行'},{code:'ccb',name:'建设银行'}];
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const clone=x=>JSON.parse(JSON.stringify(x));
const empty=()=>({version:1,transactions:[],budgetCents:10000,billCheckedMonths:[]});
const user=id=>({id,aud:'authenticated',role:'authenticated',email:id===A?'owner@example.test':'member@example.test',email_confirmed_at:'2026-10-01T00:00:00Z',app_metadata:{provider:'email'},user_metadata:{},identities:[],created_at:'2026-10-01T00:00:00Z'});
function session(id){const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');return{access_token:`${enc({alg:'HS256',typ:'JWT'})}.${enc({sub:id,role:'authenticated',aud:'authenticated',exp:4102444800})}.${Buffer.alloc(32,5).toString('base64url')}`,refresh_token:'fixture-refresh',token_type:'bearer',expires_in:864000,user:user(id)};}
function identity(request){try{return JSON.parse(Buffer.from((request.headers().authorization||'').split('.')[1],'base64url')).sub;}catch{return null;}}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,message){for(let i=0;i<120;i++){if(await fn())return;await wait(50);}throw Error(message);}
let checks=0;
function passed(x){checks++;process.stdout.write(`PASS ${x}\n`);}
function backend(project,origin,enabled=false){
 const configs=new Map([A,B].map(id=>[id,{enabled:id===A&&enabled,mode:'auto',created_at:id===A&&enabled?'2026-10-31T08:00:00Z':null,last_received_at:null,pending_count:0}]));
 const requests=[],errors=[],secrets=[],external=[]; const books=new Map([A,B].map(id=>[id,empty()]));
 return{configs,requests,errors,secrets,external,books,async attach(context){await context.route('**/*',async route=>{try{
  const req=route.request(),u=new URL(req.url());if(u.origin===origin)return route.continue();
  if(u.origin==='https://www.icloud.com'){assert.equal(req.method(),'GET');assert.equal(u.href,INSTALL);assert.equal(req.headers().referer,undefined);external.push(u.href);return route.fulfill({contentType:'text/html',body:'<title>模板测试页</title><h1>模板预览</h1>'});}
  assert.equal(u.origin,project,'unexpected external service');
  const headers={'access-control-allow-origin':origin,'access-control-allow-headers':'*','access-control-allow-methods':'GET,POST,OPTIONS','content-type':'application/json'};
  const respond=(x,status=200)=>route.fulfill({status,headers,body:JSON.stringify(x)});
  if(req.method()==='OPTIONS')return respond({});
  const body=req.postData()?JSON.parse(req.postData()):null,id=identity(req);requests.push({path:u.pathname,id,body});
  if(u.pathname==='/auth/v1/token')return respond(session(body.email==='owner@example.test'?A:B));
  if(u.pathname==='/auth/v1/user')return respond(user(id));
  if(u.pathname==='/auth/v1/logout')return respond({});
  assert(configs.has(id),'request must bind its own fixture account');
  if(u.pathname==='/rest/v1/moneytrail_ledgers')return respond([{data:clone(books.get(id)),revision:1,updated_at:'2026-10-31T08:00:00Z'}]);
  if(u.pathname==='/rest/v1/rpc/moneytrail_is_admin')return respond(false);
  if(u.pathname==='/rest/v1/rpc/moneytrail_sms_category_rules')return respond({rules:[]});
  if(u.pathname==='/rest/v1/rpc/moneytrail_sms_config')return respond(configs.get(id));
  if(u.pathname==='/rest/v1/rpc/moneytrail_sms_inbox')return respond({items:[],total:0,page:body.p_page,page_size:body.p_page_size});
  if(u.pathname==='/rest/v1/rpc/moneytrail_sms_rotate'){const token='mt_sms_'+String(secrets.length+1).padStart(64,'b');secrets.push(token);configs.set(id,{...configs.get(id),enabled:true,created_at:'2026-10-31T08:00:00Z'});return respond({token,config:configs.get(id)});}
  if(u.pathname==='/rest/v1/rpc/moneytrail_sms_revoke'){configs.set(id,{...configs.get(id),enabled:false,created_at:null});return respond(configs.get(id));}
  throw Error(`Unexpected write/endpoint ${u.pathname}`);
 }catch(e){if(/Target.*closed|already handled/.test(String(e)))return;errors.push(String(e));try{await route.abort();}catch{}}});}};
}
async function start(project,port){const origin=`http://127.0.0.1:${port}`,base=origin+'/Moneytrail-/';let output='';const server=spawn(process.execPath,[path.join(ROOT,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port)],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MONEYTRAIL_BASE_PATH:'/Moneytrail-/',VITE_SUPABASE_URL:project,VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_install_fixture',VITE_SUPABASE_ANON_KEY:''}});server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);await until(async()=>{if(server.exitCode!==null)throw Error(output);try{return /ready in/i.test(output)&&(await fetch(base)).ok;}catch{return false;}},'install test server failed');return{server,origin,base};}
async function fixture(browser,app,service,width=393){const context=await browser.newContext({viewport:{width,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai'});await service.attach(context);await context.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.__fixtureCopied=value;}}});});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(3500);await page.goto(app.base+'?view=sms',{waitUntil:'networkidle'});return{context,page,errors};}
async function login(page,email='owner@example.test'){await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill('Fixture-password-123!');await page.getByRole('button',{name:'登录我的账本',exact:true}).click();await page.getByRole('heading',{name:'短信自动记账',exact:true}).waitFor();}
async function safe(page,service,errors){assert.deepEqual(errors,[]);assert.deepEqual(service.errors,[]);const storage=await page.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)].join('\n'));for(const token of service.secrets)assert(!storage.includes(token));assert.deepEqual(service.books.get(A),empty());assert.deepEqual(service.books.get(B),empty());const d=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(d.scroll<=d.width+1);}
async function officialWorkflow(browser,app,width){const service=backend(OFFICIAL,app.origin),{context,page,errors}=await fixture(browser,app,service,width);try{
 await login(page);const guide=page.getByRole('region',{name:'iPhone 快捷指令安装'});await guide.waitFor();
 assert.equal(await guide.locator(`a[href="${INSTALL}"]`).count(),0);assert.equal(service.secrets.length,0);await guide.getByRole('button',{name:'刷新接收状态',exact:true}).click();assert.equal(service.secrets.length,0);
 await page.getByRole('button',{name:'同意转发并启用',exact:true}).click();const modal=page.getByRole('dialog',{name:'接入令牌，仅显示这一次'});await modal.waitFor();
 const link=modal.getByRole('link',{name:'打开模板安装页',exact:true});assert.equal(await link.getAttribute('href'),INSTALL);
 await modal.getByRole('button',{name:'复制令牌',exact:true}).click();assert.equal(await page.evaluate(()=>window.__fixtureCopied),service.secrets[0]);
 const popupPromise=context.waitForEvent('page');await link.click();const popup=await popupPromise;await popup.waitForLoadState();assert.equal(popup.url(),INSTALL);assert.equal(service.external.length,1);await popup.close();
 await modal.getByRole('button',{name:'我已保存',exact:true}).click();
 const install=guide.getByRole('link',{name:'安装 iPhone 快捷指令',exact:true});assert.equal(await install.getAttribute('href'),INSTALL);assert.equal(await install.getAttribute('target'),'_blank');assert.match(await install.getAttribute('rel'),/noreferrer/);
 if(width===393){const bank=guide.getByLabel('银行',{exact:true});const rotations=service.secrets.length;for(const item of THREE_BANKS){await bank.selectOption(item.code);assert.equal(await guide.locator(`a[href="${INSTALL}"]`).count(),0);assert.match(await guide.innerText(),/待确认/);assert((await guide.innerText()).includes(`信息包含「${item.name}」`));assert.equal(service.secrets.length,rotations);}await guide.getByRole('button',{name:'刷新接收状态',exact:true}).click();await guide.waitFor();assert.equal(await bank.inputValue(),'ccb');assert.equal(await guide.locator(`a[href="${INSTALL}"]`).count(),0);await page.screenshot({path:path.join(OUT,'install-ccb-393.png'),fullPage:true});await bank.selectOption('icbc');await install.waitFor();assert.equal(service.secrets.length,rotations);}
 assert(!(await guide.innerText()).includes('自动化已完成'));service.configs.get(A).last_received_at='2026-10-31T08:30:00Z';
 await guide.getByRole('button',{name:'刷新接收状态',exact:true}).click();await guide.getByText(/16:30/).waitFor();assert.equal(service.secrets.length,1);
 assert(!service.requests.some(r=>r.path.includes('receive_sms')||r.path.includes('save_moneytrail')));
 await safe(page,service,errors);await page.screenshot({path:path.join(OUT,`install-${width}.png`),fullPage:true});
 if(width===393){await guide.getByLabel('银行',{exact:true}).selectOption('boc');await page.getByRole('button',{name:'返回账本',exact:true}).click();await page.getByRole('button',{name:'我的账户',exact:true}).click();await page.getByRole('button',{name:'退出登录并清除本机副本',exact:true}).click();await page.getByRole('button',{name:'登录我的账本',exact:true}).waitFor();await page.goto(app.base+'?view=sms',{waitUntil:'networkidle'});await login(page,'member@example.test');await guide.waitFor();assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),'icbc');assert.equal(await guide.locator(`a[href="${INSTALL}"]`).count(),0);assert(!(await guide.innerText()).includes('16:30'));assert.equal(service.secrets.length,1);await safe(page,service,errors);}
 passed(`${width}px official template: consent gate, one-time copy, fixed secret-free link, read-only receipt refresh and layout${width===393?', account isolation':''}`);
 }finally{await context.close();}}
async function newBankEnableWorkflow(browser,app){const service=backend(OFFICIAL,app.origin),{context,page,errors}=await fixture(browser,app,service,320);try{await login(page);const guide=page.getByRole('region',{name:'iPhone 快捷指令安装'});await guide.getByLabel('银行',{exact:true}).selectOption('abc');await page.getByRole('button',{name:'同意转发并启用',exact:true}).click();const modal=page.getByRole('dialog',{name:'接入令牌，仅显示这一次'});await modal.waitFor();assert.equal(await modal.locator(`a[href="${INSTALL}"]`).count(),0,'new-bank enable must not offer the ICBC-only installer');await modal.getByRole('button',{name:'复制令牌',exact:true}).click();assert.equal(await page.evaluate(()=>window.__fixtureCopied),service.secrets[0]);await modal.getByRole('button',{name:'我已保存',exact:true}).click();await guide.waitFor();assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),'abc');assert.equal(await guide.locator(`a[href="${INSTALL}"]`).count(),0);await guide.locator('details').filter({hasText:'制作与分享模板（仅需一次）'}).locator('summary').click();await safe(page,service,errors);await page.screenshot({path:path.join(OUT,'install-three-bank-320.png'),fullPage:true});passed('320px new-bank enable keeps selection, lays out the expanded maker guide and never offers the ICBC-only installer in the token dialog');}finally{await context.close();}}
async function newBankTemplateWorkflow(browser,app,bank,cardKind){const service=backend(OFFICIAL,app.origin),{context,page,errors}=await fixture(browser,app,service,393);try{
 await login(page);const guide=page.getByRole('region',{name:'iPhone 快捷指令安装'});await guide.getByLabel('银行',{exact:true}).selectOption(bank.code);
 await guide.getByRole('heading',{name:'配置农中建通用模板',exact:true}).waitFor();
 assert((await guide.innerText()).includes('储蓄卡和信用卡共用'),`${bank.name} ${cardKind} must use the shared card template`);
 assert.equal(await guide.getByRole('combobox').count(),1,'card type must not require another selection');
 assert.equal(await guide.getByRole('textbox').count(),0,'generic onboarding must not require an SMS sample');
 assert((await guide.innerText()).includes(`信息包含「${bank.name}」`),'native Messages trigger must match the selected bank name');
 assert(!(await guide.innerText()).includes('信息包含「元」'));
 assert.equal(await guide.locator('a[href*="icloud.com/shortcuts/"]').count(),0,'an unpublished generic template must not offer a direct installer');
 await page.getByRole('button',{name:'同意转发并启用',exact:true}).click();const modal=page.getByRole('dialog',{name:'接入令牌，仅显示这一次'});await modal.waitFor();
 assert.equal(await modal.locator('a[href*="icloud.com/shortcuts/"]').count(),0,'new-bank token dialog must not offer the ICBC donor installer');
 await modal.getByRole('button',{name:'我已保存',exact:true}).click();await guide.waitFor();assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),bank.code);
 await guide.getByRole('heading',{name:'农中建通用模板',exact:true}).waitFor();assert.match(await guide.innerText(),/共享安装链接尚未发布/);
 const maker=guide.locator('details').filter({hasText:'制作与分享模板（仅需一次）'});assert.equal(await maker.count(),1);
 const source=guide.locator(`a[href="${THREE_BANK_SOURCE}"]`);assert.equal(await source.count(),1);assert.equal(await source.isVisible(),false,'unsigned source belongs behind the maker details');
 await maker.locator('summary').click();await source.waitFor();assert.equal(await maker.getByRole('link',{name:'下载模板源文件',exact:true}).count(),1);assert.notEqual(await source.getAttribute('download'),null,'source must be a download, not a direct Apple installer');
 const sourceResponse=await page.request.get(app.origin+THREE_BANK_SOURCE);assert.equal(sourceResponse.status(),200);const sourceText=await sourceResponse.text();assert.match(sourceText,/<plist\b/);assert.match(sourceText,/WFWorkflowActions/);
 for(const name of ['复制匹配规则','复制 iPhone 制作步骤','复制 Mac 签名命令']){await page.evaluate(()=>{window.__fixtureCopied=null;});await guide.getByRole('button',{name,exact:true}).click();const copied=await page.evaluate(()=>window.__fixtureCopied);assert.equal(typeof copied,'string');assert(copied.length>20,`${name} must copy useful template content`);for(const token of service.secrets)assert(!copied.includes(token),`${name} must not copy the personal token`);assert(!copied.includes('owner@example.test'));assert(!copied.includes(A));if(name==='复制匹配规则')for(const item of THREE_BANKS)assert(copied.includes(item.name),'the shared rule must cover all three banks');}
 for(const token of service.secrets)assert(!sourceText.includes(token),'public source must not contain a personal token');
 await guide.getByRole('button',{name:'刷新接收状态',exact:true}).click();await guide.waitFor();assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),bank.code);assert.equal(service.secrets.length,1);
 assert(!service.requests.some(r=>r.path.includes('receive_sms')||r.path.includes('save_moneytrail')));assert.deepEqual(service.external,[]);await safe(page,service,errors);
 passed(`${bank.name} ${cardKind}: shared sample-free template, bank trigger, unpublished source download, secret-free maker clipboard and selection retention`);
 }finally{await context.close();}}
async function customWorkflow(browser,app){const service=backend(CUSTOM,app.origin,true),{context,page,errors}=await fixture(browser,app,service,393);try{await login(page);const guide=page.getByRole('region',{name:'iPhone 快捷指令安装'});await guide.waitFor();assert.equal(await page.locator(`a[href="${INSTALL}"]`).count(),0);for(const bank of THREE_BANKS){await guide.getByLabel('银行',{exact:true}).selectOption(bank.code);assert.match(await guide.innerText(),/与当前部署不匹配/);assert.equal(await guide.locator(`a[href="${THREE_BANK_SOURCE}"]`).count(),0,'custom projects must not download the fixed production source');for(const name of ['复制匹配规则','复制 iPhone 制作步骤','复制 Mac 签名命令'])assert.equal(await guide.getByRole('button',{name,exact:true}).count(),0,'custom projects must not copy production template content');assert.equal(await page.locator('a[href*="icloud.com/shortcuts/"]').count(),0);}await guide.getByRole('button',{name:'刷新接收状态',exact:true}).click();assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),'ccb');assert.equal(service.secrets.length,0);await safe(page,service,errors);passed('custom project cannot offer a production installer, source download or template clipboard');}finally{await context.close();}}
(async()=>{await mkdir(OUT,{recursive:true});const browser=await chromium.launch({headless:true});try{const official=await start(OFFICIAL,5191);try{for(const bank of THREE_BANKS)for(const cardKind of ['储蓄卡','信用卡'])await newBankTemplateWorkflow(browser,official,bank,cardKind);for(const width of [320,393,1440])await officialWorkflow(browser,official,width);await newBankEnableWorkflow(browser,official);}finally{official.server.kill();}const custom=await start(CUSTOM,5192);try{await customWorkflow(browser,custom);}finally{custom.server.kill();}}finally{await browser.close();}process.stdout.write(`\n${checks} shortcut-install browser workflows passed. Apple import and real SMS triggers still require iPhone verification.\n`);})().catch(e=>{process.stderr.write(String(e.stack||e)+'\n');process.exitCode=1;});
