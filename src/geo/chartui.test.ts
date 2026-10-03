import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const chartsCode = fs
  .readFileSync(path.join(__dirname, '../../public/rp-charts.js'), 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace(/^export /gm, '');
function ui(saved: Record<string, string> = {}, fallback = false): vm.Context {
  const context = vm.createContext({ saved, URL, fallback });
  vm.runInContext(
    `
    const calls = [];
    const elements = Object.fromEntries(['localChartsToggle','localChartPicker','localChartsRefresh','localChartsNote'].map(id=>[id,{checked:false,value:'',disabled:true,children:[],handlers:{},addEventListener(event,fn){this.handlers[event]=fn;},replaceChildren(){this.children=[];},appendChild(child){this.children.push(child);}}]));
    const document = {getElementById:id=>elements[id],createElement:()=>({})};
    const localStorage = {getItem:key=>saved[key]??null,setItem:(key,value)=>saved[key]=value};
    const window = {URL,location:{origin:'http://boat:3000'}};
    class Layer {constructor(options){this.options=options;this.visible=options.visible;this.props={};this.layers=options.layers||[];} setVisible(v){this.visible=v;} set(k,v){this.props[k]=v;} get(k){return this.props[k];} getLayers(){const l=this.layers;return {forEach:fn=>l.forEach(fn),clear:()=>l.splice(0),push:item=>l.push(item)};}}
    class Source {constructor(options){this.options=options;}}
    const ol={layer:{Group:Layer,Tile:Layer},source:{XYZ:Source,TileWMS:Source},proj:{transformExtent:b=>b}};
    async function authFetch(url){calls.push(url);if(fallback && url.includes('/v2/'))return {status:404,ok:false};return {status:200,ok:true,json:async()=>({local:{name:'Local lake',format:'png',url:'/charts/{z}/{x}/{y}'},online:{name:'Online chart',type:'wms',layers:['nautical'],url:'https://charts.test/wms'}})};}
  `,
    context
  );
  vm.runInContext(chartsCode, context);
  return context;
}
const read = (context: vm.Context, expression: string): unknown => JSON.parse(JSON.stringify(vm.runInContext(expression, context)));

test('chart module wires controls, falls back to v1 and enables local charts without online charts', async () => {
  const context = ui({ 'rp:localChartsEnabled': 'true' }, true);
  await vm.runInContext('initializeSignalKCharts()', context);
  assert.deepEqual(read(context, 'calls'), ['/signalk/v2/api/resources/charts', '/signalk/v1/api/resources/charts']);
  assert.equal(vm.runInContext('localChartLayer.visible', context), true);
  assert.deepEqual(read(context, 'localChartLayer.layers.map(l=>[l.get("chartId"),l.visible])'), [
    ['local', true],
    ['online', false],
  ]);
  assert.equal(vm.runInContext('elements.localChartsToggle.disabled', context), false);
  assert.equal(vm.runInContext('typeof elements.localChartsRefresh.handlers.click', context), 'function');
  vm.runInContext('elements.localChartPicker.value="online";elements.localChartPicker.handlers.change()', context);
  assert.deepEqual(read(context, 'localChartLayer.layers.map(l=>l.visible)'), [false, true]);
  assert.equal(vm.runInContext('saved["rp:localChartChoice"]', context), 'online');
  vm.runInContext('elements.localChartsToggle.checked=false;elements.localChartsToggle.handlers.change()', context);
  assert.equal(vm.runInContext('localChartLayer.visible', context), false);
  assert.equal(vm.runInContext('saved["rp:localChartsEnabled"]', context), 'false');
});

test('chart module restores an explicit online selection after reload', async () => {
  const context = ui({ 'rp:localChartsEnabled': 'true', 'rp:localChartChoice': 'online' });
  await vm.runInContext('initializeSignalKCharts()', context);
  assert.deepEqual(read(context, 'localChartLayer.layers.map(l=>l.visible)'), [false, true]);
  assert.equal(vm.runInContext('elements.localChartPicker.value', context), 'online');
  assert.equal(vm.runInContext('localChartLayer.layers[1].options.source.options.params.LAYERS', context), 'nautical');
});

test('chart rebase migrates old base-layer preferences without replacing current upstream preferences', () => {
  const layers = fs.readFileSync(path.join(__dirname, '../../public/rp-layers.js'), 'utf8');
  const migration = layers.slice(
    layers.indexOf('// Preserve base-map'),
    layers.indexOf('for (const [id, layer, load, clear, streamlines, persist = true]')
  );
  const context = ui({ 'rp:osmEnabled': 'false', 'rp:seamarksEnabled': 'false', 'layer:seamarkToggle': 'true' });
  vm.runInContext(migration, context);
  assert.equal(vm.runInContext('saved["layer:osmToggle"]', context), 'false');
  assert.equal(vm.runInContext('saved["layer:seamarkToggle"]', context), 'true');
  assert.match(layers, /import \{ localChartLayer, initializeSignalKCharts \} from '.\/rp-charts.js'/);
  const html = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
  assert.doesNotMatch(html, /(?:onclick|onchange)="(?:updateLocalCharts|loadLocalCharts)/);
});
