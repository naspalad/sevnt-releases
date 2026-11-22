'use strict';

// Master regression inventory: separates UI/mock evidence from production integration.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const menuTest = read('tests/mac-menu-interactions.spec.js');
const runtimeTest = read('tests/mac-runtime-ui.spec.js');
const preload = read('src/preload.js');
const renderer = read('src/renderer.js');
const main = read('src/main.js');
const html = read('src/index.html');

const checks = [
{id:'clips',label:'Clips',implementation:[/#runPipeline/,/gtl-tile/],testEvidence:[/#selectModeBtn/,/#selAllBtn/,/#selClearBtn/,/#selRenderBtn/,/#selDoneBtn/,/#crRenderAllBtn/],productionBridge:[/runPipeline:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('run-pipeline'/],gaps:['Production highlight detection and real batch-render path are not exercised by the isolated QA preload.']},
{id:'clip',label:'Clip',implementation:[/function renderClipPanel\s*\(/,/id="f_fastQ"/,/id="f_burnQ"/],testEvidence:[/#f_fastQ/,/#f_burnQ/,/#f_subtitleLang/],productionBridge:[/setSettings:\s*\(cfg\)\s*=>\s*ipcRenderer\.invoke\('set-settings'/],gaps:['Trim, playback, seek, full navigation and persisted clip configuration are not covered end-to-end.']},
{id:'editor',label:'Editor',implementation:[/function openCaptionEditor\s*\(/,/function openCaptionEditorInner\s*\(/],testEvidence:[/#ce_case/,/#ce_fs/,/#ce_anim/,/#ce_addTitle/,/#ce_addMc/,/#ce_render/],productionBridge:[/renderEdit:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('render-edit'/],gaps:['Undo/redo, complete control matrix, preview parity and production render output are not fully covered.']},
{id:'watermark',label:'Watermark',implementation:[/function renderWatermarkPanel\s*\(/,/wmMod\.sanitize/,/resolveWatermark/],testEvidence:[/#wm_file/,/#wmAnchorGrid/,/#wm_x/,/#wm_y/,/#wm_size/,/#wm_op/],productionBridge:[/saveAsset:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('wm:saveAsset'/],gaps:['UI and contract tests exist; production image/text watermark and per-clip override output still need media validation.']},
{id:'crop',label:'Crop Studio',implementation:[/function renderCropPanel\s*\(/,/function openCropStudio\s*\(/,/id="csRender"/],testEvidence:[/#csAspect/,/#csZoom/,/#csAddKf/,/#csUndo/,/#csRedo/,/#csApplyAll/,/#csRender/],productionBridge:[/applyCrop:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('apply-crop'/],gaps:['Complete X/Y interaction, keyframe navigation, live preview and final-frame geometry verification remain incomplete.']},
{id:'split',label:'Split Studio',implementation:[/function openGamingSplitStudio\s*\(/,/id="ssToggleV2"/],testEvidence:[/#ssToggleV2/,/#ssMute1/,/#ssMute2/,/#ssSplitRatio/,/#ssSwapBtn/,/#ssAddKf/,/#ssApply/,/#ssRemoveV2/],productionBridge:[/applyCrop:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('apply-crop'/,/ipcMain\.handle\(['"]apply-crop['"]/],gaps:['Distinct source selection, complete position controls and rendered video/audio correctness are not proven.']},
{id:'history',label:'History',implementation:[/async function renderHistoryPanel\s*\(/],testEvidence:[/#historyPage/,/#hpSearch/,/#hpRefresh/,/#hpNew/],productionBridge:[/trashClips:\s*\(dir, items\)\s*=>\s*ipcRenderer\.invoke\('history:trashClips'/,/trashSession:\s*\(dir\)\s*=>\s*ipcRenderer\.invoke\('history:trashSession'/],gaps:['Opening a specific session, preview, deletion, refresh after restart and data persistence need end-to-end tests.']},
{id:'settings',label:'Settings',implementation:[/async function openSettings\s*\(/,/id="sv_save"/],testEvidence:[/const providers = \['gemini', 'groq', 'openai', 'openrouter', 'anthropic', 'sumopod'\]/,/#sv_asrEngine/,/#sv_save/,/#sv_licRefresh/],productionBridge:[/getSettings:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('get-settings'/,/setSettings:\s*\(cfg\)\s*=>\s*ipcRenderer\.invoke\('set-settings'/],gaps:['Real Telegram, cookies, Whisper/context model, tracker, engine updates, disk actions and restart persistence are not covered by production integration tests.']},
{id:'output',label:'Output',implementation:[/id="openOutputBtn"/,/openOutput\(null\)/],testEvidence:[/#openOutputBtn/,/openOutput/],productionBridge:[/openOutput:\s*\(sessionDir\)\s*=>\s*ipcRenderer\.invoke\('open-output'/],gaps:['Current UI check only invokes the bridge. No comprehensive ffprobe/media validation of actual exports, codecs, audio, subtitles, watermark or destination.']},
{id:'help',label:'Help',implementation:[/id="helpView"/,/function openHelp\s*\(/,/function closeHelp\s*\(/],testEvidence:[/#helpBtn/,/#helpView/,/closeHelp|railClipsBtn/],productionBridge:[/helpBtn\.addEventListener/],gaps:['Help links, all controls, section navigation and tutorial actions are not fully exercised.']}
];
const results=[];
function record(name,status,detail){results.push({name,status,detail});}

test('Master Regression: all ten menu implementations are discoverable',()=>{
 for(const item of checks){const source=renderer+'\n'+html;const missing=item.implementation.filter(p=>!p.test(source)).map(String);record(item.label+': implementation',missing.length?'FAIL':'PASS',missing.length?'Missing: '+missing.join(', '):'Implementation entry points found.');assert.deepEqual(missing,[],item.label+' implementation entry point missing');}
});
test('Master Regression: current UI test evidence exists for each menu',()=>{
 for(const item of checks){const source=menuTest+'\n'+runtimeTest;const missing=item.testEvidence.filter(p=>!p.test(source)).map(String);record(item.label+': UI test evidence',missing.length?'NOT_TESTED':'PARTIAL',missing.length?'No matching test evidence: '+missing.join(', '):'Isolated QA test evidence found; not production integration PASS.');assert.deepEqual(missing,[],item.label+' expected UI test evidence missing');}
});
test('Master Regression: production preload bridge declarations are discoverable',()=>{
 for(const item of checks){const source=preload;const missing=item.productionBridge.filter(p=>!p.test(source)).map(String);record(item.label+': production bridge',missing.length?'NOT_TESTED':'PARTIAL',missing.length?'Missing: '+missing.join(', '):'Preload bridge declaration found; main-process handler mapping is not statically proven because src/main.js is obfuscated.');assert.deepEqual(missing,[],item.label+' production bridge evidence missing');}
});
test('Master Regression: mock-backed tests are never classified as production integration PASS',()=>{
 const qa=read('tests/qa-preload.cjs');assert.match(qa,/runQaPipeline/);assert.match(qa,/renderFixture/);assert.match(qa,/testProvider:\s*asyncResult\('testProvider',\s*\{\s*ok:\s*true\s*\}\)/);record('Production integration classification','PASS','QA preload uses deterministic fixtures/stubs; production integration remains unproven.');
});
test('Master Regression: write machine-readable coverage report',()=>{
 const dir=path.join(ROOT,'test-results');fs.mkdirSync(dir,{recursive:true});
 const report={generatedAt:new Date().toISOString(),branchContext:'qa/macos-functional-suite-v2',overall:'PARTIAL',policy:'Mock-backed UI checks and static bridge discovery are not production integration PASS.',menus:checks.map(item=>({id:item.id,label:item.label,implementation:'PASS_IF_SUITE_GREEN',currentUiCoverage:'PARTIAL',productionIntegration:'NOT_PROVEN',gaps:item.gaps})),checks:results,nextRequired:['Add production Electron main/preload integration tests without qa-preload.cjs.','Validate actual output files with ffprobe and decode representative frames/audio.','Add persistent-state tests across app restart.','Complete uncovered controls listed per menu.']};
 const target=path.join(dir,'master-regression-report.json');fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');record('Machine-readable report','PASS',target);
 console.log('\nMASTER REGRESSION SUMMARY');for(const item of report.menus)console.log(item.label+': implementation='+item.implementation+'; UI='+item.currentUiCoverage+'; production='+item.productionIntegration);console.log('Report: '+target);
});
