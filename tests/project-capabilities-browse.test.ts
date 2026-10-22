import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { queryTableImages } from '../src/lib/project-capabilities/table-data';
const require = createRequire(__filename);
require('../src/lib/feishu-api').getFeishuTenantAccessToken = async () => 'fixture';
async function main() {
  const source = { key: 'approved-images', baseToken: 'fixture', tableId: 'tblFixture', searchField: 'machine', imageFields: ['approved-image'], viewId: 'viewFixture' };
  const previous = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /tables\/tblFixture\/records\/search/);
    assert.match(String(url), /page_size=20/);
    const body: unknown = JSON.parse(String(init?.body));
    assert(body && typeof body === 'object' && !Array.isArray(body));
    bodies.push(Object.fromEntries(Object.entries(body)));
    return new Response(JSON.stringify({ code: 0, data: { items: [{ record_id: 'recFixture', fields: { machine: 'actual-machine-42', secret: 'must not escape', 'approved-image': [] } }], has_more: true, page_token: 'next-page' } }));
  };
  try {
    const first = await queryTableImages(source, '');
    assert.deepEqual(bodies[0].field_names, ['machine', 'approved-image']);
    assert.equal(bodies[0].view_id, 'viewFixture');
    assert.doesNotMatch(JSON.stringify(bodies[0].filter), /contains/);
    assert.match(JSON.stringify(bodies[0].filter), /approved-image/);
    assert.doesNotMatch(JSON.stringify(first), /secret|must not escape/);
    assert.equal(first.records[0].text, '"actual-machine-42"');
    assert.equal(first.cursor, 'next-page');
    await queryTableImages(source, '', first.cursor!);
    await queryTableImages(source, 'actual-machine');
    assert.match(JSON.stringify(bodies[2].filter), /contains/);
    await assert.rejects(queryTableImages(source, ' '.repeat(3)), /查询文本/);
    await assert.rejects(queryTableImages(source, '', '\n'), /游标/);
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 1254018, msg: 'InvalidFilter', error: { message: "There is no option 'Z036' for field 'brand'" } }));
    await assert.rejects(queryTableImages(source, 'Z036'), error => error instanceof Error && /1254018.*InvalidFilter/.test(error.message) && !/核对应用和资源授权/.test(error.message));
    console.log('Approved table browse keeps the exact view, fields, attachment filter and bounded pagination; explicit searches and invalid-input guards remain intact');
  } finally { globalThis.fetch = previous; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
