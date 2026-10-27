const assert = require('node:assert/strict')
const {test} = require('node:test')
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
function load(file, mocks = {}, expose = '') {
 const module = {exports:{}}
 const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText
 new Function('require','module','exports',js + (expose ? '\nmodule.exports.__test = {'+expose+'}' : ''))(name => name === '@shared/promptPresets' ? load('shared/promptPresets.ts') : mocks[name] ?? require(name),module,module.exports)
 return module.exports
}
const styles = load('shared/styles.ts')
const speech = load('shared/speech.ts')
const instructions = load('shared/storyInstructions.ts', {'./speech':speech})

test('default creative prompts remain available and blank overrides restore them', () => {
 assert.match(instructions.scriptSystem('English',''),/The first scene is a strong hook/)
 assert.match(instructions.visualSystem('  '),/Keep every recurring character visually consistent/)
 for(const invalid of [null, {}, 'x'.repeat(instructions.INSTRUCTION_LIMIT+1)]) assert.equal(instructions.resolveInstructions(invalid,'default'),'default')
})
test('custom creative instructions replace defaults but retain output, language and silent pauses', () => {
 const script = instructions.scriptSystem('Indonesian','Start with a surprising question. Never add a subscribe CTA.')
 assert.match(script,/Start with a surprising question/)
 assert.doesNotMatch(script,/The last scene can invite/)
 assert.match(script,/Write everything in Indonesian/)
 assert.match(script,/JSON schema/)
 assert.match(script,/No audible breathing/)
 const visual = instructions.visualSystem('Show the consequences of the previous scene.')
 assert.match(visual,/consequences of the previous scene/)
 assert.match(visual,/only the requested numbered scenes/)
 assert.match(visual,/in English/)
})
test('settings persist independently, reject invalid overrides and support reset', () => {
 const values = new Map()
 const db={prepare: sql => ({all:()=> [...values].map(([key,value])=>({key,value})),run:(k,v)=>values.set(k,v)}),transaction:fn=>()=>fn()}
 const api=load('main/settings.ts', {
  '@shared/storyInstructions':instructions, '@shared/styles':styles,
  '@shared/higgsfield':{DEFAULT_IMAGE_MODEL:'image',DEFAULT_VIDEO_MODEL:'video',getImageModel:id=>({id}),getVideoModel:id=>({id})},
  '@shared/media':{isFlowModel:()=>false}, './db':{getDb:()=>db}
 })
 assert.equal(api.getSettings().scriptInstructions,'')
 api.setSettings({scriptInstructions:'My hook'})
 api.setSettings({visualInstructions:'My continuity'})
 assert.equal(api.getSettings().scriptInstructions,'My hook')
 assert.equal(api.getSettings().visualInstructions,'My continuity')
 assert.throws(()=>api.setSettings({scriptInstructions:42}),/Instruksi/)
 assert.throws(()=>api.setSettings({visualInstructions:'x'.repeat(instructions.INSTRUCTION_LIMIT+1)}),/Instruksi/)
 api.setSettings({scriptInstructions:''})
 assert.equal(api.getSettings().scriptInstructions,'')
 assert.equal(api.getSettings().visualInstructions,'My continuity')
})
test('actual story pipeline uses saved instructions and preserves schemas and project context', async () => {
 const settings={scriptInstructionsMode:'custom',visualInstructionsMode:'custom',scriptInstructions:'Start with an unanswered question.',visualInstructions:'Progress the action between scenes.',visualStyleOverrides:{'stickman-minimalist':{mode:'custom',prompt:'STYLE_CUSTOM_LINE_ART',characterHint:'CHAR_CUSTOM_WHITE_HEAD'}}}
 const project={title:'Test',synopsis:'What if the Mongol Empire survived?',language:'en',durationSec:360,styleId:'stickman-minimalist',aspectRatio:'16:9'}
 const clips=[{id:'one',title:'First',story:'An empire survives.',narration:'The empire survived.',cameraPreset:'static',motionStrength:'halus',transition:'cut'}]
 const requests=[]
 let replaced, applied
 const api=load('main/story.ts', {
  '@shared/motion':{CAMERA_PRESETS:[{id:'static'}],MOTION_STRENGTHS:[{id:'halus'}],TRANSITIONS:[{id:'cut'}]},
  '@shared/models':{LANGUAGES:[{code:'en',english:'English'}],clipCountFor:()=>65},
  '@shared/script':{estimateNarrationMs:()=>5000,needsVisual:()=>true},
  '@shared/storyInstructions':instructions,'@shared/styles':styles,
  './settings':{getSettings:()=>({...settings})},
  './services/visualRetry':load('main/services/visualRetry.ts'),
  './repo':{getProject:()=>project,getBundle:()=>({project,clips}),clipsOf:()=>clips,charactersOf:()=>[{name:'Khan',description:'red headband'}],replaceScript:(...args)=>{replaced=args},applyVisuals:(...args)=>{applied=args}},
  './services/llm':{generateJson:async req=>{requests.push(req);return req.name==='script'?{title:'Title',scenes:[{title:'First',story:'Story',narration:'Words'}]}:{world:'Empire',characters:[],scenes:[{scene:1,setting:'Mongolia',action:'The Khan stands.',wardrobe:[],framing:'Wide shot',avoid:'cars',characters:[],motion:'Wind moves.',camera:'static',strength:'halus',transition:'cut'}]}}}
 })
 await api.generateScript('project')
 applied = await api.generateVisualBatch('project',[1],{world:'Empire',characters:[{name:'Khan',description:'red headband'}],states:[]},new AbortController().signal)
 assert.match(requests[0].system,/Start with an unanswered question/)
 assert.match(requests[0].prompt,/Write exactly 65 scenes/)
 assert.match(requests[1].system,/Progress the action between scenes/)
 assert.match(requests[1].prompt,/Full script:/)
 assert.match(requests[1].prompt,/Stickman minimalist/)
 assert.match(requests[1].prompt,/Khan: red headband/)
 assert.match(requests[1].prompt,/STYLE_CUSTOM_LINE_ART/)
 assert.match(requests[1].prompt,/CHAR_CUSTOM_WHITE_HEAD/)
 assert.equal(replaced[2][0].narration,'Words')
 assert.equal(applied[0].clipId,'one')
 const schemas=requests.map(r=>r.schema)
 settings.scriptInstructionsMode='original';settings.visualInstructionsMode='original'
 await api.generateScript('project');await api.generateVisualBatch('project',[1],{world:'Empire',characters:[],states:[]},new AbortController().signal)
 assert.deepEqual(requests[2].schema,schemas[0]);assert.deepEqual(requests[3].schema,schemas[1])
 assert.doesNotMatch(requests[2].system,/Start with an unanswered question/)
 assert.doesNotMatch(requests[3].system,/Progress the action between scenes/)
 assert.equal(settings.scriptInstructions,'Start with an unanswered question.')
})


test('Original bypasses saved custom instructions without deleting them', () => {
 const saved='Never include a subscribe CTA.'
 assert.doesNotMatch(instructions.scriptSystem('English',saved,'original'),/Never include/)
 assert.match(instructions.scriptSystem('English',saved,'custom'),/Never include/)
 assert.doesNotMatch(instructions.visualSystem('Use a red sky.','original'),/Use a red sky/)
})

test('style overrides are isolated, reversible, and never mutate the built-in catalog', () => {
 const original=styles.getStyle('stickman-minimalist')
 const catalog=JSON.stringify(styles.VISUAL_STYLES)
 const overrides={'stickman-minimalist':{mode:'custom',prompt:'CUSTOM_STYLE',characterHint:'CUSTOM_CHARACTER'}}
 assert.equal(styles.getStyle('stickman-minimalist',overrides).prompt,'CUSTOM_STYLE')
 assert.equal(styles.getStyle('stickman-minimalist',overrides).characterHint,'CUSTOM_CHARACTER')
 assert.equal(styles.getStyle('stickman',overrides).prompt,styles.getStyle('stickman').prompt)
 overrides['stickman-minimalist'].mode='original'
 assert.equal(styles.getStyle('stickman-minimalist',overrides).prompt,original.prompt)
 assert.equal(overrides['stickman-minimalist'].prompt,'CUSTOM_STYLE')
 overrides['stickman-minimalist'].mode='custom'
 assert.equal(styles.getStyle('stickman-minimalist',overrides).prompt,'CUSTOM_STYLE')
 assert.equal(JSON.stringify(styles.VISUAL_STYLES),catalog)
})

test('settings migrate legacy custom text and merge style edits without affecting another style', () => {
 const values=new Map([['scriptInstructions',JSON.stringify('Legacy hook')]])
 const db={prepare:()=>({all:()=>[...values].map(([key,value])=>({key,value})),run:(k,v)=>values.set(k,v)}),transaction:fn=>()=>fn()}
 const api=load('main/settings.ts', {'@shared/storyInstructions':instructions,'@shared/styles':styles,'@shared/higgsfield':{DEFAULT_IMAGE_MODEL:'image',DEFAULT_VIDEO_MODEL:'video',getImageModel:id=>({id}),getVideoModel:id=>({id})},'@shared/media':{isFlowModel:()=>false},'./db':{getDb:()=>db}})
 assert.equal(api.getSettings().scriptInstructionsMode,'custom')
 assert.equal(api.getSettings().visualInstructionsMode,'original')
 api.setSettings({scriptInstructionsMode:'original'})
 assert.equal(api.getSettings().scriptInstructions,'Legacy hook')
 assert.equal(api.getSettings().scriptInstructionsMode,'original')
 const custom={mode:'custom',prompt:'STYLE_A',characterHint:'CHAR_A'}
 api.setSettings({visualStyleOverrides:{'stickman-minimalist':custom}})
 api.setSettings({visualStyleOverrides:{stickman:{mode:'custom',prompt:'STYLE_B',characterHint:'CHAR_B'}}})
 assert.equal(api.getSettings().visualStyleOverrides['stickman-minimalist'].prompt,'STYLE_A')
 api.setSettings({visualStyleOverrides:{'stickman-minimalist':{...custom,mode:'original'}}})
 assert.equal(api.getSettings().visualStyleOverrides['stickman-minimalist'].prompt,'STYLE_A')
 assert.equal(api.getSettings().visualStyleOverrides.stickman.prompt,'STYLE_B')
 assert.throws(()=>api.setSettings({scriptInstructionsMode:'invalid'}),/mode/)
 for(const entry of [null,{...custom,mode:'invalid'},{...custom,prompt:42},{...custom,characterHint:'x'.repeat(instructions.INSTRUCTION_LIMIT+1)}]) assert.throws(()=>api.setSettings({visualStyleOverrides:{stickman:entry}}),/Gaya visual/)
 assert.throws(()=>api.setSettings({visualStyleOverrides:{unknown:custom}}),/Gaya visual/)
})

test('actual image and reference-sheet builders use the same effective style', () => {
 const settings={visualStyleOverrides:{'stickman-minimalist':{mode:'custom',prompt:'SCENE_STYLE_SENTINEL',characterHint:'CHARACTER_STYLE_SENTINEL'}}}
 // Only prompt builders run; no provider, browser, filesystem or database calls.
 const mocks=new Proxy({'@shared/styles':styles,'./settings':{getSettings:()=>settings}}, {get:(target,key)=>target[key]??{}})
 const {clipPrompt,sheetPrompt}=load('main/generation.ts',mocks,'clipPrompt,sheetPrompt').__test
 const project={styleId:'stickman-minimalist',aspectRatio:'16:9'}
 const clip={visualPrompt:'Setting: a palace.\nAction: a ruler sits.\nWardrobe: Khan - default outfit\nAvoid: modern cars'}
 const character={name:'Khan',description:'red headband'}
 assert.match(clipPrompt(project,clip,[character],['Khan'],100000),/SCENE_STYLE_SENTINEL/)
 assert.match(sheetPrompt(project,character),/SCENE_STYLE_SENTINEL/)
 assert.match(sheetPrompt(project,character),/CHARACTER_STYLE_SENTINEL/)
 assert.match(sheetPrompt(project,character),/front view, three-quarter view and side view/)
 settings.visualStyleOverrides['stickman-minimalist'].mode='original'
 assert.doesNotMatch(clipPrompt(project,clip,[],[],100000),/SCENE_STYLE_SENTINEL/)
 assert.doesNotMatch(sheetPrompt(project,character),/CHARACTER_STYLE_SENTINEL/)
})


test('prompt slots preserve legacy instructions and validate named collections without changing global behavior',()=>{
 const values=new Map([['scriptInstructions',JSON.stringify('LEGACY_CHANNEL_A')],['visualInstructions',JSON.stringify('LEGACY_VISUAL_A')]])
 const db={prepare:sql=>({all:()=>[...values].map(([key,value])=>({key,value})),run:(k,v)=>values.set(k,v)}),transaction:fn=>()=>fn()}
 const api=load('main/settings.ts',{'@shared/storyInstructions':instructions,'@shared/styles':styles,'@shared/higgsfield':{DEFAULT_IMAGE_MODEL:'image',DEFAULT_VIDEO_MODEL:'video',getImageModel:id=>({id}),getVideoModel:id=>({id})},'@shared/media':{isFlowModel:()=>false},'./db':{getDb:()=>db}})
 const initial=api.getSettings(),legacy=initial.promptPresets[0]
 assert.equal(legacy.name,'Prompt lama');assert.equal(legacy.scriptInstructions,'LEGACY_CHANNEL_A');assert.equal(legacy.scriptInstructionsMode,'custom')
 assert.ok(!values.has('promptPresets'),'Reading settings must not rewrite legacy data')
 const second={...structuredClone(legacy),id:'channel-b',name:'Channel B',scriptInstructions:'CHANNEL_B_RULES'}
 api.setSettings({promptPresets:[legacy,second]})
 assert.equal(api.getSettings().scriptInstructions,'LEGACY_CHANNEL_A')
 assert.equal(api.getSettings().promptPresets[1].scriptInstructions,'CHANNEL_B_RULES')
 for(const bad of [[legacy,{...second,id:legacy.id}],[legacy,{...second,name:' prompt lama '}],[{...second,scriptInstructions:42}],[{...second,visualInstructionsMode:'wrong'}],[{...second,visualStyleOverrides:{unknown:{mode:'custom',prompt:'x',characterHint:'y'}}}]])
  assert.throws(()=>api.setSettings({promptPresets:bad}),/Preset/)
 api.setSettings({promptPresets:[]});assert.deepEqual(api.getSettings().promptPresets,[])
 assert.equal(api.getSettings().visualInstructions,'LEGACY_VISUAL_A')
})

test('snapshot instructions and image references remain in their channel when global prompts change',async()=>{
 const helper=load('shared/promptPresets.ts'),base=helper.ORIGINAL_PROMPT_PRESET
 const settings={...base,promptPresets:[{...base,id:'a',name:'Channel A',scriptInstructionsMode:'custom',visualInstructionsMode:'custom',scriptInstructions:'CHANNEL_A_HOOK',visualInstructions:'CHANNEL_A_CONTINUITY',visualStyleOverrides:{'stickman-minimalist':{mode:'custom',prompt:'CHANNEL_A_ART',characterHint:'CHANNEL_A_SHEET'}}}]}
 const profile=helper.snapshotPromptPreset(settings,'a'),project={promptProfile:profile,styleId:'stickman-minimalist',aspectRatio:'16:9'}
 settings.promptPresets[0].visualStyleOverrides['stickman-minimalist'].prompt='CHANNEL_B_ART'
 settings.scriptInstructions='GLOBAL_OTHER_CHANNEL';settings.visualStyleOverrides={'stickman-minimalist':{mode:'custom',prompt:'GLOBAL_OTHER_ART',characterHint:'GLOBAL_OTHER_SHEET'}}
 const effective=helper.projectPromptSettings(settings,project)
 assert.match(instructions.scriptSystem('English',effective.scriptInstructions,effective.scriptInstructionsMode),/CHANNEL_A_HOOK/)
 assert.match(instructions.visualSystem(effective.visualInstructions,effective.visualInstructionsMode),/CHANNEL_A_CONTINUITY/)
 const mocks=new Proxy({'@shared/styles':styles,'./settings':{getSettings:()=>settings}}, {get:(target,key)=>target[key]??{}})
 const {clipPrompt,sheetPrompt}=load('main/generation.ts',mocks,'clipPrompt,sheetPrompt').__test
 assert.match(clipPrompt(project,{visualPrompt:'A location'},[],[],100000),/CHANNEL_A_ART/)
 assert.match(sheetPrompt(project,{name:'Lead',description:'An approved character.'}),/CHANNEL_A_SHEET/)
 settings.promptPresets=[]
 assert.equal(helper.projectPromptSettings(settings,project).scriptInstructions,'CHANNEL_A_HOOK')
 const original=helper.snapshotPromptPreset(settings,'original')
 assert.deepEqual(helper.projectPromptSettings(settings,{promptProfile:original}).visualStyleOverrides,{})
 assert.equal(helper.projectPromptSettings(settings,{promptProfile:null}).scriptInstructions,'GLOBAL_OTHER_CHANNEL')
 assert.throws(()=>helper.snapshotPromptPreset(settings,'deleted'),/tidak ditemukan/)
})


test('shared protagonist styling cannot be presented as the identity of every supporting character',()=>{
 const settings={visualStyleOverrides:{noir:{mode:'custom',prompt:'Detective Who has white temple streaks and a taupe raincoat.',characterHint:'Create a character reference sheet for Detective Who, a 43-year-old man.'}}}
 const mocks=new Proxy({'@shared/styles':styles,'./settings':{getSettings:()=>settings}}, {get:(target,key)=>target[key]??{}})
 const {clipPrompt,sheetPrompt}=load('main/generation.ts',mocks,'clipPrompt,sheetPrompt').__test
 const p={styleId:'noir',aspectRatio:'16:9'},elise={name:'Elise Hale',description:'Human woman, late twenties. Default outfit: emerald blouse and black trousers.'}
 const prompt=sheetPrompt(p,elise)
 assert.ok(prompt.startsWith('Character reference sheet for "Elise Hale". Render ONLY this target identity: '+elise.description))
 assert.match(prompt,/Shared sheet presentation guidance:/);assert.doesNotMatch(prompt,/The character is Create a character reference sheet for Detective Who/)
 assert.match(prompt,/Final identity check: every view depicts "Elise Hale" only/)
 assert.ok(prompt.lastIndexOf(elise.description)>prompt.lastIndexOf('43-year-old man'),'The final authority must restore the target rather than the shared host description')
 for(const limit of [100000,10])assert.match(clipPrompt(p,{visualPrompt:'Elise studies a document.'},[elise],[],limit),/never add the channel protagonist/)
})
