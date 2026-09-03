/* Answer pads. The same builder drives the host stage and the player's phone,
   so an option's colour and shape are identical on both. */

/**
 * @param {HTMLElement} container
 * @param {{text:string}[]} options
 * @param {{host?:boolean, interactive?:boolean, onPick?:(i:number)=>void}} opts
 * @returns {HTMLElement[]} the pad elements, in option order
 */
function buildPads(container, options, opts = {}) {
  const { host = false, interactive = false, onPick = null } = opts;

  container.textContent = '';
  container.className = `pads${host ? ' pads--host' : ''} pads--n${options.length}`;

  return options.map((option, i) => {
    const style = answerStyle(i);
    const pad = document.createElement(interactive ? 'button' : 'div');
    pad.className = 'pad';
    pad.style.background = style.color;
    if (interactive) {
      pad.type = 'button';
      pad.addEventListener('click', () => onPick?.(i));
    }

    const glyph = document.createElement('span');
    glyph.className = 'pad__glyph';
    glyph.textContent = style.glyph;
    glyph.setAttribute('aria-hidden', 'true');
    pad.appendChild(glyph);

    const text = document.createElement('span');
    text.className = 'pad__text';
    text.textContent = option.text;
    pad.appendChild(text);

    container.appendChild(pad);
    return pad;
  });
}

/**
 * Dim everything except the right answer(s), optionally showing how many people
 * picked each option and which ones this player chose.
 *
 * `correct` is an option index or an array of them.
 */
function revealPads(pads, correct, { tallies = null, chosen = [] } = {}) {
  const right = new Set(Array.isArray(correct) ? correct : [correct]);
  const picked = new Set(Array.isArray(chosen) ? chosen : [chosen]);

  pads.forEach((pad, i) => {
    if (pad.tagName === 'BUTTON') pad.disabled = true;
    pad.classList.toggle('pad--dim', !right.has(i));
    pad.classList.toggle('pad--right', right.has(i));
    pad.classList.toggle('pad--chosen', picked.has(i));
    // A wrong pick stays visible so players can see what they got wrong.
    pad.classList.toggle('pad--missed', picked.has(i) && !right.has(i));

    if (tallies) {
      const tally = document.createElement('span');
      tally.className = 'pad__tally';
      tally.textContent = tallies[i];
      pad.appendChild(tally);
    }
  });
}

/** Marks the option(s) this player locked in and disables the lot. */
function lockPads(pads, chosen) {
  const picked = new Set(Array.isArray(chosen) ? chosen : [chosen]);
  pads.forEach((pad, i) => {
    if (pad.tagName === 'BUTTON') pad.disabled = true;
    pad.classList.toggle('pad--chosen', picked.has(i));
    pad.classList.toggle('pad--dim', !picked.has(i));
  });
}

/** Shows which options are currently ticked, while still editable. */
function markSelected(pads, selected) {
  const picked = new Set(selected);
  pads.forEach((pad, i) => {
    pad.classList.toggle('pad--picked', picked.has(i));
    pad.setAttribute('aria-pressed', String(picked.has(i)));
  });
}
