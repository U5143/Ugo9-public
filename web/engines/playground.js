// SPDX-FileCopyrightText: 2026 U5143
// SPDX-License-Identifier: MIT
// The panel every engine page shares (three.html, pixi.html, phaser.html): a list of the model's
// animations, a slider per parameter, the microphone moving the mouth (through a noise gate, the
// same numbers as the engines' helpers), and the name of the part last clicked. The pages only
// set up their engine and call panel.apply(instance, dt, seconds) each frame, after reset().
import { UgoMouth, UgoBlink } from '../ugo.js';
import { VoiceLevel, Microphone } from '../tracking.js';

export function makePanel(host, model) {
  const el = (tag, props = {}, ...kids) => {
    const { dataset, ...rest } = props;
    const e = Object.assign(document.createElement(tag), rest);
    if (dataset) Object.assign(e.dataset, dataset);
    e.append(...kids);
    return e;
  };
  host.classList.add('ugo-panel');
  const state = { animation: model.animations[0]?.name ?? '', set: new Map(), picked: '', micOn: false, blink: true };

  // animations
  const anim = el('select', { id: 'anim' }, el('option', { value: '', textContent: '（なし）' }),
    ...model.animations.map((a) => el('option', { value: a.name, textContent: a.name, selected: a.name === state.animation })));
  anim.onchange = () => { state.animation = anim.value; };
  host.append(el('label', { className: 'row' }, el('span', { textContent: 'アニメ' }), anim));

  // blinking on its own
  const blinkBox = el('input', { type: 'checkbox', id: 'blink', checked: true });
  blinkBox.onchange = () => { state.blink = blinkBox.checked; };
  host.append(el('label', { className: 'row' }, blinkBox, el('span', { textContent: '自分でまばたき' })));

  // the microphone: loudness -> noise gate -> mouth
  const mic = el('button', { id: 'mic', textContent: 'マイクで口を動かす' });
  const micStatus = el('span', { id: 'micStatus', className: 'note' });
  const gate = new VoiceLevel(), mouth = new UgoMouth(model);
  let microphone = null;
  mic.onclick = async () => {
    if (microphone) { microphone.close(); microphone = null; mouth.level = -1; mic.textContent = 'マイクで口を動かす'; micStatus.textContent = ''; state.micOn = false; return; }
    try {
      microphone = await Microphone.open();
      mic.textContent = 'マイクを止める';
      state.micOn = true;
    } catch (e) {
      micStatus.textContent = `マイクが使えません（${e.name}）`;
    }
  };
  host.append(el('div', { className: 'row' }, mic, micStatus));

  // the part clicked
  const picked = el('output', { id: 'picked', textContent: '—' });
  host.append(el('div', { className: 'row' }, el('span', { textContent: 'クリックしたパーツ' }), picked));

  // a slider per parameter: one moved by hand overrides the animation until 元に戻す
  const sliders = el('div', { className: 'sliders' });
  const reset = el('button', { id: 'resetParams', textContent: 'パラメータを元に戻す' });
  const inputs = [];
  for (const p of model.params) {
    const out = el('output', { textContent: p.def.toFixed(2) });
    const input = el('input', { type: 'range', min: p.min, max: p.max, step: (p.max - p.min) / 200, value: p.def, dataset: { param: p.name } });
    input.oninput = () => { state.set.set(p.name, Number(input.value)); out.textContent = Number(input.value).toFixed(2); };
    inputs.push([input, out, p]);
    sliders.append(el('label', { className: 'slider' }, el('span', { textContent: p.name }), input, out));
  }
  reset.onclick = () => { state.set.clear(); for (const [i, o, p] of inputs) { i.value = p.def; o.textContent = p.def.toFixed(2); } };
  host.append(reset, sliders);

  const blink = new UgoBlink(model);
  return {
    state,
    /** Each frame, after inst.reset() and before inst.update(dt). */
    apply(inst, dt, seconds) {
      if (state.animation) inst.play(state.animation, seconds);
      for (const [name, v] of state.set) inst.set(name, v);
      if (state.blink) { blink.update(dt); blink.apply(inst); }
      if (microphone) mouth.level = gate.update(microphone.db(), dt);
      mouth.update(dt);
      mouth.apply(inst);
    },
    /** Shows the part's name (null: nothing there). */
    showPick(name) { state.picked = name ?? ''; picked.textContent = name ?? '（何も無い所）'; },
  };
}

/** The look of the panel (the pages put it next to their canvas). */
export const PANEL_CSS = `
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #f2f0ea; color: #222; display: flex; flex-wrap: wrap; }
  #view { flex: 1 1 480px; min-width: 320px; }
  #view canvas { display: block; max-width: 100%; }
  .ugo-panel { flex: 0 1 320px; padding: 12px 16px; box-sizing: border-box; max-height: 100vh; overflow: auto; }
  .ugo-panel .row { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
  .ugo-panel .slider { display: grid; grid-template-columns: 110px 1fr 44px; gap: 6px; align-items: center; font-size: 12px; }
  .ugo-panel .note { color: #a33; font-size: 12px; }
  .ugo-panel h1 { font-size: 16px; margin: 0 0 8px; }
  @media (prefers-color-scheme: dark) { body { background: #1e1e1e; color: #ddd; } }
`;
