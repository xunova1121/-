import assert from 'node:assert/strict';
import { normalizeStage, removeStageObject, createHistory } from '../ui/previz-stage.js';

const make = () => normalizeStage({ subjects: [{ id: 'actor', name: '人物', assetId: 'original' }], marks: [{ id: 'prop' }], lights: [{ id: 'light' }], keyframes: [{ frame: 0, values: { actor: { x: 1 }, prop: { x: 2 } } }, { frame: 24, values: { actor: { x: 3 } } }] });
let checks = 0;
for (const [id, bucket] of [['actor', 'subjects'], ['prop', 'marks'], ['light', 'lights']]) {
  const stage = make(), before = JSON.stringify(stage), history = createHistory(stage);
  assert.equal(removeStageObject(stage, id).ok, true);
  assert.equal(stage[bucket].length, 0);
  assert.ok(stage.keyframes.every(k => !Object.hasOwn(k.values, id)));
  assert.ok(stage.keyframes.every(k => Object.keys(k.values).length));
  history.commit();
  assert.equal(history.undo(), true);
  assert.equal(JSON.stringify(stage), before);
  assert.equal(history.redo(), true);
  assert.equal(stage[bucket].length, 0);
  checks++;
}
for (const key of ['attachToId', 'focusId', 'targetId']) {
  for (const animated of [false, true]) {
    const stage = make();
    if (animated) stage.keyframes.push({ frame: 48, values: { prop: { [key]: 'actor' } } });
    else stage.marks[0][key] = 'actor';
    const before = JSON.stringify(stage);
    assert.equal(removeStageObject(stage, 'actor').ok, false);
    assert.equal(JSON.stringify(stage), before);
    checks++;
  }
}
{
  const stage = make();
  stage.subjects[0].locked = true;
  assert.equal(removeStageObject(stage, 'actor').ok, false);
  assert.equal(removeStageObject(stage, stage.cam.id).ok, false);
  assert.equal(removeStageObject(stage, 'missing').ok, false);
  assert.equal(stage.subjects[0].assetId, 'original');
  checks++;
}
console.log(`PASS: ${checks} removal, reference protection and undo/redo scenarios`);
