/* Real SDK + intercepted service fixtures. Does not execute the Apple shortcut. */
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {mkdir} = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const smsProfile = require('../public/shortcuts/bank-sms-v4-profile.json');
const ROOT=path.resolve(__dirname,'..'), OUT=path.join(ROOT,'test-results','sms-install');
const OFFICIAL='https://ojcgabicpjipwpvwolzn.supabase.co', CUSTOM='https://custom-install-fixture.supabase.co';
const INSTALL='https://www.icloud.com/shortcuts/86d33de8ff704d6581c173b82f3f4f21';
const THREE_BANK_INSTALL='https://www.icloud.com/shortcuts/90ce49ad282d490481700cfe8868b82d';
const THREE_BANK_SOURCE='/Moneytrail-/shortcuts/moneytrail-three-bank-v1.unsigned.plist';
const GENERAL_BANK_SOURCE='/Moneytrail-/shortcuts/moneytrail-general-bank-v2.unsigned.plist';
const BANK_ACTIVITY_SOURCE='/Moneytrail-/shortcuts/moneytrail-bank-activity-v3.unsigned.plist';
const SMS_CATEGORY_SOURCE='/Moneytrail-/shortcuts/moneytrail-bank-sms-category-beta.unsigned.plist';
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
function backend(project,origin,enabled=false,{iphone=false}={}){
 const configs=new Map([A,B].map(id=>[id,{enabled:id===A&&enabled,mode:'auto',created_at:id===A&&enabled?'2026-10-31T08:00:00Z':null,last_received_at:null,pending_count:0}]));
 const preferences=new Map();
 const requests=[],errors=[],secrets=[],external=[]; const books=new Map([A,B].map(id=>[id,empty()]));
 return{configs,requests,errors,secrets,external,books,async attach(context){await context.route('**/*',async route=>{try{
  const req=route.request(),u=new URL(req.url());if(u.origin===origin)return route.continue();
  if(u.origin==='https://www.icloud.com'){assert.equal(req.method(),'GET');assert([INSTALL,THREE_BANK_INSTALL,smsProfile.url].includes(u.href),'only a fixed, secret-free template link may open');assert.equal(req.headers().referer,undefined);external.push(u.href);return route.fulfill({contentType:'text/html',body:'<title>模板测试页</title><h1>模板预览</h1>'});}
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
  if(u.pathname==='/rest/v1/rpc/moneytrail_sms_activity_summary')return respond({period_start:'2026-10-24T08:00:00Z',period_end:'2026-10-31T08:00:00Z',time_zone:'Asia/Shanghai',received_count:0,recorded_count:0,pending_count:0,dismissed_count:0});
  if(u.pathname==='/rest/v1/rpc/moneytrail_sms_config')return respond(configs.get(id));
  if(u.pathname==='/rest/v1/rpc/moneytrail_sms_beta_get_preferences')return iphone
   ? respond(preferences.get(id)??{mode:configs.get(id).mode,category_depth:'primary'}) : respond({code:'PGRST202'},404);
  if(iphone&&u.pathname==='/rest/v1/rpc/moneytrail_sms_beta_set_preferences'){
   const next={mode:body.p_mode,category_depth:body.p_category_depth};preferences.set(id,next);return respond(next);
  }
  if(u.pathname==='/rest/v1/rpc/moneytrail_sms_inbox')return respond({items:[],total:0,page:body.p_page,page_size:body.p_page_size});
  if(u.pathname==='/rest/v1/rpc/moneytrail_sms_rotate'){const token='mt_sms_'+String(secrets.length+1).padStart(64,'b');secrets.push(token);configs.set(id,{...configs.get(id),enabled:true,mode:body.p_mode,created_at:'2026-10-31T08:00:00Z'});return respond({token,config:configs.get(id)});}
  if(u.pathname==='/rest/v1/rpc/moneytrail_sms_revoke'){configs.set(id,{...configs.get(id),enabled:false,created_at:null});return respond(configs.get(id));}
  throw Error(`Unexpected write/endpoint ${u.pathname}`);
 }catch(e){if(/Target.*closed|already handled/.test(String(e)))return;errors.push(String(e));try{await route.abort();}catch{}}});}};
}
async function start(project,port){const origin=`http://127.0.0.1:${port}`,base=origin+'/Moneytrail-/';let output='';const server=spawn(process.execPath,[path.join(ROOT,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(port)],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,MONEYTRAIL_BASE_PATH:'/Moneytrail-/',VITE_SUPABASE_URL:project,VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_install_fixture',VITE_SUPABASE_ANON_KEY:''}});server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);await until(async()=>{if(server.exitCode!==null)throw Error(output);try{return /ready in/i.test(output)&&(await fetch(base)).ok;}catch{return false;}},'install test server failed');return{server,origin,base};}
async function fixture(browser,app,service,width=393,{publishedSms=false}={}){
 const context=await browser.newContext({viewport:{width,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai'});
 await service.attach(context);
 if(!publishedSms)await context.route(
  url=>url.origin===app.origin&&url.pathname.endsWith('/bank-sms-v4-profile.json')&&url.searchParams.has('import'),
  route=>route.fulfill({contentType:'application/javascript',body:`export default ${JSON.stringify({...smsProfile,url:null})}`}),
 );
 await context.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.__fixtureCopied=value;}}});});
 const page=await context.newPage();const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
 await page.goto(app.base+'?view=sms',{waitUntil:'networkidle',timeout:20000});
 return{context,page,errors};
}
async function login(page,email='owner@example.test'){await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill('Fixture-password-123!');await page.getByRole('button',{name:'登录我的账本',exact:true}).click();await page.getByRole('heading',{name:'短信自动记账',exact:true}).waitFor();}
async function safe(page,service,errors){assert.deepEqual(errors,[]);assert.deepEqual(service.errors,[]);const storage=await page.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)].join('\n'));for(const token of service.secrets)assert(!storage.includes(token));assert.deepEqual(service.books.get(A),empty());assert.deepEqual(service.books.get(B),empty());const d=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(d.scroll<=d.width+1);}
async function openLegacy(guide){const summary=guide.getByText('仅接收支出：旧版模板与配置',{exact:true});if(await summary.count()&&!await summary.evaluate(e=>e.parentElement.open))await summary.click();}
async function publishedSmsWorkflow(browser,app){
 const service=backend(OFFICIAL,app.origin),{context,page,errors}=await fixture(browser,app,service,320,{publishedSms:true});
 try{
  await login(page);
  const guide=page.getByRole('region',{name:'iPhone 快捷指令安装'});
  await guide.getByRole('heading',{name:'绑定银行短信',exact:true}).waitFor();
  assert(await guide.getByRole('button',{name:'安装收支快捷指令',exact:true}).isDisabled());
  await guide.getByLabel('银行',{exact:true}).selectOption('cmb');
  assert((await guide.innerText()).includes('实际发送招商银行收支短信的号码'));
  assert((await guide.innerText()).includes('关闭「运行前确认」'));
  const compatibility=guide.getByText('编辑页找不到「自动化」时',{exact:true}).locator('..');
  assert.equal(await compatibility.evaluate(element=>element.open),false);
  const advanced=guide.getByText('高级配置：本机规则缓存与更新',{exact:true}).locator('..');
  assert.equal(await advanced.evaluate(element=>element.open),false);
  assert.equal(await guide.getByText('仅接收支出：旧版模板与配置',{exact:true}).count(),0);
  assert.equal(await guide.getByRole('button',{name:'刷新接收状态',exact:true}).count(),0);
  assert.equal(await guide.getByText('服务器最近接收',{exact:true}).count(),0);
  assert.equal(await page.locator('summary').filter({hasText:'iPhone 配置步骤'}).count(),0);
  const ruleStatus=advanced.locator('[aria-label="银行规则发布状态"]');
  assert.equal(await ruleStatus.isVisible(),false);
  await advanced.locator('summary').first().click();
  await ruleStatus.getByRole('button',{name:'检查网页规则版本',exact:true}).waitFor();
  await advanced.locator('summary').first().click();
  await page.getByRole('button',{name:'同意转发并启用',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'接入令牌，仅显示这一次'});
  const install=modal.getByRole('link',{name:'打开收支模板安装页',exact:true});
  assert.equal(await install.getAttribute('href'),smsProfile.url);
  await modal.getByRole('button',{name:'复制令牌',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__fixtureCopied),service.secrets[0]);
  const popupPromise=context.waitForEvent('page');
  await install.click();
  const popup=await popupPromise;
  await popup.waitForLoadState();
  assert.equal(popup.url(),smsProfile.url);
  await popup.close();
  await modal.getByRole('button',{name:'我已保存',exact:true}).click();
  assert.equal(await guide.getByRole('link',{name:'安装收支快捷指令',exact:true}).getAttribute('href'),smsProfile.url);
  assert.equal(await guide.getByRole('link',{name:'安装收支快捷指令',exact:true}).count(),1);
  await page.getByRole('button',{name:'刷新收件箱',exact:true}).click();
  assert.equal(service.secrets.length,1,'the remaining receipt refresh must not rotate the token');
  await safe(page,service,errors);
  await page.screenshot({path:path.join(OUT,'install-single-320.png'),fullPage:true,animations:'disabled'});
  passed('published single shortcut: direct trigger instructions and token-free installer for every bank');
 }finally{await context.close();}
}
async function iphoneCategoryInstallWorkflow(browser,app){
 const service=backend(OFFICIAL,app.origin,false,{iphone:true}),{context,page,errors}=await fixture(browser,app,service,320,{publishedSms:true});
 try{
  await login(page);
  await page.getByRole('radio',{name:/在 iPhone 确认/}).check();
  const setup=page.getByRole('region',{name:'在 iPhone 上接入',exact:true});
  const source=setup.getByRole('link',{name:'下载未签名快捷指令',exact:true});
  assert.equal(await source.getAttribute('href'),SMS_CATEGORY_SOURCE);
  assert.notEqual(await source.getAttribute('download'),null);
  assert.equal(await setup.locator('a[href*="icloud.com/shortcuts/"]').count(),0);
  const artifact=await page.request.get(app.origin+SMS_CATEGORY_SOURCE);
  assert.equal(artifact.status(),200);
  assert.match(await artifact.text(),/moneytrail_sms_beta_prepare_v2/);
  await setup.getByRole('button',{name:'复制签名命令',exact:true}).click();
  assert.match(await page.evaluate(()=>window.__fixtureCopied),/shortcuts sign --mode anyone .*MoneyTrail-SMS-Category-Beta\.shortcut/);
  await page.getByRole('button',{name:'同意转发并启用',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'接入令牌，仅显示这一次'});
  assert.equal(await modal.getByRole('link',{name:'下载未签名快捷指令',exact:true}).getAttribute('href'),SMS_CATEGORY_SOURCE);
  assert.equal(await modal.locator('a[href*="icloud.com/shortcuts/"]').count(),0);
  await modal.getByRole('button',{name:'我已保存',exact:true}).click();
  await setup.waitFor();
  assert.equal(service.configs.get(A).mode,'review');
  assert.equal(service.secrets.length,1);
  await safe(page,service,errors);
  passed('320px iPhone category setup and first-enable token dialog offer the unsigned beta and Mac signing command');
 }finally{await context.close();}
}
async function officialWorkflow(browser,app,width){const service=backend(OFFICIAL,app.origin),{context,page,errors}=await fixture(browser,app,service,width);try{
 await login(page);const guide=page.getByRole('region',{name:'iPhone 快捷指令安装'});await guide.waitFor();await openLegacy(guide);
 assert.equal(await guide.locator(`a[href="${INSTALL}"]`).count(),0);assert.equal(service.secrets.length,0);await guide.getByRole('button',{name:'刷新接收状态',exact:true}).click();assert.equal(service.secrets.length,0);
 await page.getByRole('button',{name:'同意转发并启用',exact:true}).click();const modal=page.getByRole('dialog',{name:'接入令牌，仅显示这一次'});await modal.waitFor();
 const link=modal.getByRole('link',{name:'打开支出模板安装页',exact:true});assert.equal(await link.getAttribute('href'),INSTALL);
 await modal.getByRole('button',{name:'复制令牌',exact:true}).click();assert.equal(await page.evaluate(()=>window.__fixtureCopied),service.secrets[0]);
 const popupPromise=context.waitForEvent('page');await link.click();const popup=await popupPromise;await popup.waitForLoadState();assert.equal(popup.url(),INSTALL);assert.equal(service.external.length,1);await popup.close();
 await modal.getByRole('button',{name:'我已保存',exact:true}).click();await openLegacy(guide);
 const install=guide.getByRole('link',{name:'安装支出快捷指令',exact:true});assert.equal(await install.getAttribute('href'),INSTALL);assert.equal(await install.getAttribute('target'),'_blank');assert.match(await install.getAttribute('rel'),/noreferrer/);
 if(width===393){const bank=guide.getByLabel('银行',{exact:true});const rotations=service.secrets.length;for(const item of THREE_BANKS){await bank.selectOption(item.code);await openLegacy(guide);assert.equal(await guide.locator(`a[href="${INSTALL}"]`).count(),0);assert.equal(await guide.getByRole('link',{name:'安装支出快捷指令',exact:true}).getAttribute('href'),THREE_BANK_INSTALL);assert.match(await guide.innerText(),/待确认/);assert((await guide.innerText()).includes(`信息包含「${item.name}」`));assert.equal(service.secrets.length,rotations);}await guide.getByRole('button',{name:'刷新接收状态',exact:true}).click();await guide.waitFor();assert.equal(await bank.inputValue(),'ccb');assert.equal(await guide.locator(`a[href="${INSTALL}"]`).count(),0);await page.screenshot({path:path.join(OUT,'install-ccb-393.png'),fullPage:true});await bank.selectOption('icbc');await openLegacy(guide);await install.waitFor();assert.equal(await install.getAttribute('href'),INSTALL);assert.equal(await guide.locator(`a[href="${THREE_BANK_INSTALL}"]`).count(),0);assert.equal(service.secrets.length,rotations);}
 assert(!(await guide.innerText()).includes('自动化已完成'));service.configs.get(A).last_received_at='2026-10-31T08:30:00Z';
 await guide.getByRole('button',{name:'刷新接收状态',exact:true}).click();await guide.getByText(/16:30/).waitFor();assert.equal(service.secrets.length,1);
 assert(!service.requests.some(r=>r.path.includes('receive_sms')||r.path.includes('save_moneytrail')));
 await safe(page,service,errors);await page.screenshot({path:path.join(OUT,`install-${width}.png`),fullPage:true});
 if(width===393){await guide.getByLabel('银行',{exact:true}).selectOption('boc');await page.getByRole('button',{name:'返回账本',exact:true}).click();await page.getByRole('button',{name:'我的账户',exact:true}).click();await page.getByRole('button',{name:'退出登录并清除本机副本',exact:true}).click();await page.getByRole('button',{name:'登录我的账本',exact:true}).waitFor();await page.goto(app.base+'?view=sms',{waitUntil:'networkidle'});await login(page,'member@example.test');await guide.waitFor();assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),'icbc');assert.equal(await guide.locator(`a[href="${INSTALL}"]`).count(),0);assert(!(await guide.innerText()).includes('16:30'));assert.equal(service.secrets.length,1);await safe(page,service,errors);}
 passed(`${width}px official template: consent gate, one-time copy, fixed secret-free link, read-only receipt refresh and layout${width===393?', account isolation':''}`);
 }finally{await context.close();}}
async function newBankEnableWorkflow(browser,app){
 const service=backend(OFFICIAL,app.origin),{context,page,errors}=await fixture(browser,app,service,320);
 try{
  await login(page);
  const guide=page.getByRole('region',{name:'iPhone 快捷指令安装'});
  await guide.getByLabel('银行',{exact:true}).selectOption('abc');await openLegacy(guide);
  await page.getByRole('button',{name:'同意转发并启用',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'接入令牌，仅显示这一次'});
  await modal.waitFor();
  assert.equal(await modal.locator(`a[href="${INSTALL}"]`).count(),0,'new-bank enable must not offer the ICBC-only installer');
  assert.equal(await modal.getByRole('link',{name:'打开支出模板安装页',exact:true}).getAttribute('href'),THREE_BANK_INSTALL);
  await safe(page,service,errors);
  await page.screenshot({path:path.join(OUT,'install-three-bank-token-320.png'),fullPage:true});
  await modal.getByRole('button',{name:'复制令牌',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__fixtureCopied),service.secrets[0]);
  await modal.getByRole('button',{name:'我已保存',exact:true}).click();await openLegacy(guide);
  await guide.waitFor();
  assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),'abc');
  assert.equal(await guide.getByRole('link',{name:'安装支出快捷指令',exact:true}).getAttribute('href'),THREE_BANK_INSTALL);
  await guide.getByText('制作与分享模板（仅需一次）',{exact:true}).click();
  await safe(page,service,errors);
  await page.screenshot({path:path.join(OUT,'install-three-bank-320.png'),fullPage:true});
  passed('320px new-bank enable preserves bank selection, offers the matching installer in the token dialog and fits the expanded maintenance guide');
 }finally{await context.close();}
}
async function newBankTemplateWorkflow(browser,app,bank,cardKind){const service=backend(OFFICIAL,app.origin),{context,page,errors}=await fixture(browser,app,service,393);try{
 await login(page);const guide=page.getByRole('region',{name:'iPhone 快捷指令安装'});await guide.getByLabel('银行',{exact:true}).selectOption(bank.code);await openLegacy(guide);
 await guide.getByRole('heading',{name:'农中建通用模板',exact:true}).waitFor();
 assert((await guide.innerText()).includes('储蓄卡和信用卡共用'),`${bank.name} ${cardKind} must use the shared card template`);
 assert.equal(await guide.getByRole('combobox').count(),1,'card type must not require another selection');
 assert.equal(await guide.getByRole('textbox').count(),0,'generic onboarding must not require an SMS sample');
 assert((await guide.innerText()).includes(`信息包含「${bank.name}」`),'native Messages trigger must match the selected bank name');
 assert(!(await guide.innerText()).includes('信息包含「元」'));
 assert.equal(await guide.locator('a[href*="icloud.com/shortcuts/"]').count(),0,'a generic installer requires personal access to be enabled');
 assert.equal(await guide.getByRole('button',{name:'安装支出快捷指令',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'同意转发并启用',exact:true}).click();const modal=page.getByRole('dialog',{name:'接入令牌，仅显示这一次'});await modal.waitFor();
 assert.equal(await modal.locator(`a[href="${INSTALL}"]`).count(),0,'new-bank token dialog must not offer the ICBC donor installer');
 const tokenLink=modal.getByRole('link',{name:'打开支出模板安装页',exact:true});
 assert.equal(await tokenLink.getAttribute('href'),THREE_BANK_INSTALL);
 const popupPromise=context.waitForEvent('page');await tokenLink.click();const popup=await popupPromise;await popup.waitForLoadState();assert.equal(popup.url(),THREE_BANK_INSTALL);await popup.close();
 await modal.getByRole('button',{name:'我已保存',exact:true}).click();await openLegacy(guide);await guide.waitFor();assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),bank.code);
 await guide.getByRole('heading',{name:'农中建通用模板',exact:true}).waitFor();
 assert(!(await guide.getByText('仅接收支出：旧版模板与配置',{exact:true}).locator('..').innerText()).includes('共享安装链接尚未发布'));
 const installer=guide.getByRole('link',{name:'安装支出快捷指令',exact:true});
 assert.equal(await installer.getAttribute('href'),THREE_BANK_INSTALL);
 assert.equal(await installer.getAttribute('target'),'_blank');assert.match(await installer.getAttribute('rel'),/noreferrer/);
 const maker=guide.getByText('制作与分享模板（仅需一次）',{exact:true}).locator('..');assert.equal(await maker.count(),1);
 const source=guide.locator(`a[href="${THREE_BANK_SOURCE}"]`);assert.equal(await source.count(),1);assert.equal(await source.isVisible(),false,'unsigned source belongs behind the maker details');
 await maker.locator('summary').click();await source.waitFor();assert.equal(await maker.getByRole('link',{name:'下载模板源文件',exact:true}).count(),1);assert.notEqual(await source.getAttribute('download'),null,'source must be a download, not a direct Apple installer');
 const sourceResponse=await page.request.get(app.origin+THREE_BANK_SOURCE);assert.equal(sourceResponse.status(),200);const sourceText=await sourceResponse.text();assert.match(sourceText,/<plist\b/);assert.match(sourceText,/WFWorkflowActions/);
 for(const name of ['复制匹配规则','复制 iPhone 制作步骤','复制 Mac 签名命令']){await page.evaluate(()=>{window.__fixtureCopied=null;});await guide.getByRole('button',{name,exact:true}).click();const copied=await page.evaluate(()=>window.__fixtureCopied);assert.equal(typeof copied,'string');assert(copied.length>20,`${name} must copy useful template content`);for(const token of service.secrets)assert(!copied.includes(token),`${name} must not copy the personal token`);assert(!copied.includes('owner@example.test'));assert(!copied.includes(A));if(name==='复制匹配规则')for(const item of THREE_BANKS)assert(copied.includes(item.name),'the shared rule must cover all three banks');}
 for(const token of service.secrets)assert(!sourceText.includes(token),'public source must not contain a personal token');
 await guide.getByRole('button',{name:'刷新接收状态',exact:true}).click();await guide.waitFor();assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),bank.code);assert.equal(service.secrets.length,1);
 assert(!service.requests.some(r=>r.path.includes('receive_sms')||r.path.includes('save_moneytrail')));assert.deepEqual(service.external,[THREE_BANK_INSTALL]);await safe(page,service,errors);
 passed(`${bank.name} ${cardKind}: consent-gated shared installer, matching token handoff, fixed secret-free URL, bank trigger and selection retention`);
 }finally{await context.close();}}
async function cmbTemplateWorkflow(browser,app){const service=backend(OFFICIAL,app.origin),{context,page,errors}=await fixture(browser,app,service,320);try{
 await login(page);const guide=page.getByRole('region',{name:'iPhone 快捷指令安装'});await guide.getByLabel('银行',{exact:true}).selectOption('cmb');await openLegacy(guide);
 await guide.getByRole('heading',{name:'通用银行模板（含招商银行）',exact:true}).waitFor();
 assert((await guide.innerText()).includes('“信息包含”留空'));assert((await guide.innerText()).includes('MoneyTrail 通用银行记账'));
 assert((await guide.innerText()).includes('95555'));assert((await guide.innerText()).includes('以真实短信为准'));
 assert((await guide.innerText()).includes('旧农中建模板不会转发招商银行短信'));
 assert.equal(await guide.getByRole('button',{name:'安装支出快捷指令',exact:true}).isDisabled(),true);
 assert.equal(await guide.locator('a[href*="icloud.com/shortcuts/"]').count(),0);
 await page.getByRole('button',{name:'同意转发并启用',exact:true}).click();const modal=page.getByRole('dialog',{name:'接入令牌，仅显示这一次'});await modal.waitFor();
 assert.equal(await modal.getByRole('link',{name:'打开支出模板安装页',exact:true}).count(),0,'CMB must never receive the older three-bank or ICBC installer');
 await modal.getByRole('button',{name:'复制令牌',exact:true}).click();assert.equal(await page.evaluate(()=>window.__fixtureCopied),service.secrets[0]);
 await modal.getByRole('button',{name:'我已保存',exact:true}).click();await openLegacy(guide);assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),'cmb');
 const source=guide.locator(`a[href="${GENERAL_BANK_SOURCE}"]`);await source.waitFor();assert.notEqual(await source.getAttribute('download'),null);
 const sourceText=await (await page.request.get(app.origin+GENERAL_BANK_SOURCE)).text();assert.match(sourceText,/<plist\b/);assert(sourceText.includes('招商银行'));
 await guide.getByRole('button',{name:'复制匹配规则',exact:true}).click();const pattern=await page.evaluate(()=>window.__fixtureCopied);
 const matcher=new RegExp(pattern,'iu');
 assert(matcher.test('【招商银行】您尾号1234卡消费人民币28.70元。'));
 assert(matcher.test('〖招商银行〗您账户0000于04月09日06:43在〖支付宝-payee〗快捷支付114.15元，余额9999.99元\u200c\ufffc'));
 assert(matcher.test('您尾号3436的招行信用卡于12月24日18时4分消费人民币256.05元'));
 assert(!matcher.test('【招商银行】您尾号1234卡消费人民币28.70元，验证码123456。'));
 assert(!matcher.test('〖招商银行〗您账户0000快捷支付114.15元，验\u200c证码123456'));
 assert(!matcher.test('您尾号3436的招行信用卡于12月24日18时4分消费人民币256.05元【中国银行】'));
 await guide.getByRole('button',{name:'复制 iPhone 制作步骤',exact:true}).click();const steps=await page.evaluate(()=>window.__fixtureCopied);
 assert(steps.includes(THREE_BANK_INSTALL));assert(steps.includes('整体替换'));assert(steps.includes('令牌文本留空'));
 await guide.getByRole('button',{name:'复制 Mac 签名命令',exact:true}).click();assert((await page.evaluate(()=>window.__fixtureCopied)).includes('moneytrail-general-bank-v2.unsigned.plist'));
 for(const token of service.secrets){assert(!sourceText.includes(token));assert(!steps.includes(token));assert(!pattern.includes(token));}
 await guide.getByRole('button',{name:'刷新接收状态',exact:true}).click();assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),'cmb');assert.equal(service.secrets.length,1);
 await safe(page,service,errors);await page.screenshot({path:path.join(OUT,'install-cmb-320.png'),fullPage:true,animations:'disabled'});
 passed('CMB preserves personal token selection, exposes the v2 update rule and unsigned source, never offers an incompatible installer, and fits 320px');
 }finally{await context.close();}}
async function publishedRulesWorkflow(browser,app){
 const service=backend(OFFICIAL,app.origin),{context,page,errors}=await fixture(browser,app,service,320);
 const requests=[];let fail=true;
 try{
  await context.route('**/shortcuts/bank-rules.json',async route=>{const request=route.request();requests.push(request);if(fail)return route.fulfill({status:503,contentType:'application/json',body:'{}'});return route.continue();});
  await login(page);
  const advanced = page.getByText('高级配置：本机规则缓存与更新',{exact:true});
  await advanced.click();
  const status=page.getByRole('region',{name:'银行规则发布状态',exact:true});
  await status.getByText('规则版本读取未完成。现有快捷指令与收件箱继续按原配置运行，可稍后重试。',{exact:true}).waitFor();
  await page.getByRole('heading',{name:'等待第一条银行交易短信',exact:true}).waitFor();
  const inboxReads = () => service.requests.filter(request=>request.path.endsWith('/moneytrail_sms_inbox')).length;
  const beforeRefresh = inboxReads();
  await page.getByRole('button',{name:'刷新接收状态',exact:true}).click();
  await until(()=>inboxReads()>beforeRefresh,'receipt refresh should still work when the rules are unavailable');
  await advanced.waitFor();
  if(!await advanced.evaluate(element=>element.parentElement.open))await advanced.click();
  assert.equal(service.secrets.length,0,'checking a rule version cannot rotate a personal token');
  fail=false;await status.getByRole('button',{name:'检查网页规则版本',exact:true}).click();
  await status.getByText(/网页已发布规则 v1/).waitFor();
  assert((await status.innerText()).includes('此清单供本机缓存版使用'));
  await status.getByRole('button',{name:'复制已发布匹配规则',exact:true}).click();
  const pattern=await page.evaluate(()=>window.__fixtureCopied);assert(new RegExp(pattern,'iu').test('尾号0000卡11月10日14:50工商银行收入(2026年10月工资)18,000元，余额1xxx元。【工商银行】'));
  for(const request of requests){assert.equal(request.method(),'GET');assert.equal(request.headers().authorization,undefined);assert.equal(request.headers().cookie,undefined);assert.equal(request.postData(),null);}
  await safe(page,service,errors);await page.screenshot({path:path.join(OUT,'published-rules-320.png'),fullPage:true,animations:'disabled'});
  passed('public rule failure does not block the inbox; retry and copy use no token and make no phone-update claim');
 }finally{await context.close();}
}
async function bankActivityWorkflow(browser,app){
 const service=backend(OFFICIAL,app.origin),{context,page,errors}=await fixture(browser,app,service,320);
 try{
  await login(page);const guide=page.getByRole('region',{name:'iPhone 快捷指令安装'});
  const activity=page.getByRole('region',{name:'收入与支出快捷指令',exact:true});await activity.waitFor();
  await activity.getByText('维护者选项：制作与签名收支模板',{exact:true}).click();
  const source=activity.getByRole('link',{name:'下载收支模板源文件',exact:true});await source.waitFor();
  assert.equal(await source.getAttribute('href'),BANK_ACTIVITY_SOURCE);
  const sourceText=await(await page.request.get(app.origin+BANK_ACTIVITY_SOURCE)).text();assert.match(sourceText,/<plist\b/);assert(!sourceText.includes('mt_sms_'));
  for(const bank of [{code:'icbc',name:'工商银行'},...THREE_BANKS,{code:'cmb',name:'招商银行'}]){
   await guide.getByLabel('银行',{exact:true}).selectOption(bank.code);
   assert((await activity.innerText()).includes('收入'));assert((await activity.innerText()).includes('待确认'));
   assert.equal(await activity.getByRole('button',{name:'安装收支快捷指令',exact:true}).isDisabled(),true);
   assert.equal(await activity.locator('a[href*="icloud.com/shortcuts/"]').count(),0,'an unshared income template must not offer a legacy installer');
  }
  await activity.getByRole('button',{name:'复制收支匹配规则',exact:true}).click();const pattern=await page.evaluate(()=>window.__fixtureCopied);const matcher=new RegExp(pattern,'iu');
  for(const body of ['尾号0000卡11月10日14:50工商银行收入(2026年10月工资)18,000元，余额1xxx元。【工商银行】','尾号0000卡11月10日14:50工商银行收入(工资)18，xxx元，余额1xxx元。【工商银行】','【农业银行】您账户0000收入人民币1000.00元。','【中国银行】您账户0000到账人民币1000元。','【建设银行】您账户0000存入1000元。','〖招商银行〗您账户0000转入1000元。','您尾号3436的招行信用卡于12月24日18时4分消费人民币256.05元'])assert(matcher.test(body),'v3 should route signed income candidates and keep the established CMB credit format');
  assert(!matcher.test('尾号0000卡收入(工资)1000元，验证码123456。【工商银行】'));
  assert(!matcher.test('【工商银行】收入1000元【中国银行】'));
  await activity.getByRole('button',{name:'复制收支iPhone步骤',exact:true}).click();const steps=await page.evaluate(()=>window.__fixtureCopied);assert(steps.includes(THREE_BANK_INSTALL));assert(steps.includes('MoneyTrail 银行收支记账'));assert(steps.includes('留空'));
  await activity.getByRole('button',{name:'复制收支Mac签名命令',exact:true}).click();assert((await page.evaluate(()=>window.__fixtureCopied)).includes('moneytrail-bank-activity-v3.unsigned.plist'));
  assert.equal(service.secrets.length,0,'public preparation steps must not rotate a personal token');
  await safe(page,service,errors);await page.screenshot({path:path.join(OUT,'install-bank-activity-320.png'),fullPage:true,animations:'disabled'});
  passed('all five banks expose the v3 income/expense rule, blank shared source and iPhone handoff without an incompatible installer');
 }finally{await context.close();}
}
async function customWorkflow(browser,app){const service=backend(CUSTOM,app.origin,true),{context,page,errors}=await fixture(browser,app,service,393);try{await login(page);const guide=page.getByRole('region',{name:'iPhone 快捷指令安装'});await guide.waitFor();await openLegacy(guide);assert.equal(await page.locator(`a[href="${INSTALL}"]`).count(),0);for(const bank of [{code:'icbc',name:'工商银行'},...THREE_BANKS,{code:'cmb',name:'招商银行'}]){await guide.getByLabel('银行',{exact:true}).selectOption(bank.code);assert.match(await guide.innerText(),/与当前部署不匹配/);for(const source of [THREE_BANK_SOURCE,BANK_ACTIVITY_SOURCE])assert.equal(await guide.locator(`a[href="${source}"]`).count(),0,'custom projects must not download fixed production sources');for(const name of ['复制匹配规则','复制 iPhone 制作步骤','复制 Mac 签名命令','复制收支匹配规则','复制收支iPhone步骤','复制收支Mac签名命令','复制已发布匹配规则'])assert.equal(await guide.getByRole('button',{name,exact:true}).count(),0,'custom projects must not copy production template content');assert.equal(await page.locator('a[href*="icloud.com/shortcuts/"]').count(),0);}await guide.getByRole('button',{name:'刷新接收状态',exact:true}).click();assert.equal(await guide.getByLabel('银行',{exact:true}).inputValue(),'cmb');assert.equal(service.secrets.length,0);await safe(page,service,errors);passed('custom project cannot offer a production installer, source download or template clipboard');}finally{await context.close();}}
(async()=>{await mkdir(OUT,{recursive:true});const browser=await chromium.launch({headless:true,...(process.env.MONEYTRAIL_CHROMIUM_PATH?{executablePath:process.env.MONEYTRAIL_CHROMIUM_PATH}:{}),args:['--no-sandbox']});try{const official=await start(OFFICIAL,5191);try{await iphoneCategoryInstallWorkflow(browser,official);await publishedSmsWorkflow(browser,official);for(const bank of THREE_BANKS)for(const cardKind of ['储蓄卡','信用卡'])await newBankTemplateWorkflow(browser,official,bank,cardKind);for(const width of [320,393,1440])await officialWorkflow(browser,official,width);await newBankEnableWorkflow(browser,official);await cmbTemplateWorkflow(browser,official);await bankActivityWorkflow(browser,official);await publishedRulesWorkflow(browser,official);}finally{official.server.kill();}const custom=await start(CUSTOM,5192);try{await customWorkflow(browser,custom);}finally{custom.server.kill();}}finally{await browser.close();}process.stdout.write(`\n${checks} shortcut-install browser workflows passed. Browser coverage ends at the Apple install page.\n`);})().catch(e=>{process.stderr.write(String(e.stack||e)+'\n');process.exitCode=1;});
