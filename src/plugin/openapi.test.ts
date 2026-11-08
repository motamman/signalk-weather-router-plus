import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { openApi30, openApiDocument } from './openapi';

test('openApi30: null, const and tuples as OpenAPI 3.0 writes them', () => {
  assert.deepEqual(openApi30(Type.Union([Type.Number(), Type.Null()], { description: 'd' })), {
    type: 'number',
    description: 'd',
    nullable: true,
  });
  assert.deepEqual(openApi30(Type.Literal(true)), { type: 'boolean', enum: [true] });
  assert.deepEqual(openApi30(Type.Union([Type.Tuple([Type.Number(), Type.Number()]), Type.Null()])), {
    type: 'array',
    items: { type: 'number' },
    minItems: 2,
    maxItems: 2,
    nullable: true,
  });
});

type Op = { responses: Record<string, { content?: Record<string, { schema: unknown }> }> };
type Paths = Record<string, Record<string, Op>>;

test('the OpenAPI document: the job document lists what JobPublic carries, and nothing 3.0 lacks', () => {
  const doc = openApiDocument('/p');
  const json = JSON.stringify(doc);
  assert.ok(!json.includes('"type":"null"') && !json.includes('"const":') && !json.includes('patternProperties'));
  const paths = doc.paths as Paths;
  const job = paths['/api/routes/{id}'].get.responses[200].content!['application/json'].schema as {
    properties: Record<string, unknown>;
  };
  assert.ok('window_id' in job.properties);
  assert.deepEqual(Object.keys((job.properties.links as { properties: object }).properties), [
    'self',
    'events',
    'result',
    'skeleton',
    'fronts',
    'cancel',
    'publish',
    'meteogram',
  ]);
});

test('the OpenAPI document: a window or set started (202) is documented as the handler answers it, not as the window or set itself', () => {
  const paths = openApiDocument('/p').paths as Paths;
  const created = (p: string): { properties: Record<string, { type?: string }>; required: string[] } =>
    paths[p].post.responses[202].content!['application/json'].schema as {
      properties: Record<string, { type?: string }>;
      required: string[];
    };
  const win = created('/api/windows');
  assert.deepEqual(Object.keys(win.properties), ['id', 'status', 'departures', 'links']);
  assert.equal(win.properties.departures.type, 'integer', 'the count, not the list');
  assert.deepEqual(win.required, ['id', 'status', 'departures', 'links']);
  const set = created('/api/ensemble-sets');
  assert.deepEqual(Object.keys(set.properties), ['id', 'status', 'members', 'links']);
  assert.equal(set.properties.members.type, 'integer');
});
