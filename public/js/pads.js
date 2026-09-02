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
 * Dim everything except the right answer, optionally showing how many people
 * picked each option and which one this player chose.
 */
function revealPads(pads, correctIndex, { tallies = null, chosenIndex = null } = {}) {
  pads.forEach((pad, i) => {
    if (pad.tagName === 'BUTTON') pad.disabled = true;
    pad.classList.toggle('pad--dim', i !== correctIndex);
    pad.classList.toggle('pad--right', i === correctIndex);
    pad.classList.toggle('pad--chosen', i === chosenIndex);

    if (tallies) {
      const tally = document.createElement('span');
      tally.className = 'pad__tally';
      tally.textContent = tallies[i];
      pad.appendChild(tally);
    }
  });
}

/** Marks the option this player locked in and disables the rest. */
function lockPads(pads, chosenIndex) {
  pads.forEach((pad, i) => {
    if (pad.tagName === 'BUTTON') pad.disabled = true;
    pad.classList.toggle('pad--chosen', i === chosenIndex);
    pad.classList.toggle('pad--dim', i !== chosenIndex);
  });
}
