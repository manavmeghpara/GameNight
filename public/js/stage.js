/* The host's media stage: plays a question's image, audio or video clip.
   Host screen only — players never receive the media. */

const EQ_BARS = 7;

/**
 * Renders a question's media into `container` and starts playback.
 * @returns {() => void} a cleanup function; always call it before the next question.
 */
function mountMedia(container, question) {
  container.textContent = '';
  if (!question.media) return () => {};

  const { kind } = question.media;
  const start = question.clipStart ?? 0;
  const end = question.clipEnd ?? null;

  if (kind === 'image') {
    const img = document.createElement('img');
    img.src = question.media.url;
    img.alt = '';
    container.appendChild(img);
    return () => container.textContent = '';
  }

  // "Audio only" hides a video's picture, so a video question can quiz on a
  // line of dialogue without giving the scene away.
  const audioOnly = kind === 'audio' || question.hideVideo;
  const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
  el.src = question.media.url;
  el.preload = 'auto';
  el.playsInline = true;

  let visual;
  if (audioOnly) {
    el.hidden = true;
    visual = equalizer();
    container.append(visual, el);
  } else {
    container.appendChild(el);
  }

  const note = document.createElement('p');
  note.className = 'media-note';

  // Seek to the clip start as soon as the browser knows the duration.
  const onMeta = () => {
    if (start > 0 && Number.isFinite(el.duration)) {
      el.currentTime = Math.min(start, Math.max(0, el.duration - 0.1));
    }
  };
  el.addEventListener('loadedmetadata', onMeta);

  // Stop at the clip end rather than running on into the next scene.
  const onTime = () => {
    if (end != null && el.currentTime >= end) {
      el.pause();
      visual?.classList.add('eq--paused');
    }
  };
  el.addEventListener('timeupdate', onTime);

  const onEnded = () => visual?.classList.add('eq--paused');
  el.addEventListener('ended', onEnded);

  let tapButton = null;
  const play = () => {
    const attempt = el.play();
    if (!attempt?.catch) return;
    attempt.catch(() => {
      // Autoplay was blocked. Offer a tap instead of silently showing nothing.
      if (tapButton) return;
      visual?.classList.add('eq--paused');
      tapButton = document.createElement('button');
      tapButton.type = 'button';
      tapButton.className = 'tap-to-play';
      tapButton.textContent = `▶ Tap to play the ${kind}`;
      tapButton.addEventListener('click', () => {
        tapButton.remove();
        tapButton = null;
        visual?.classList.remove('eq--paused');
        el.play().catch(() => {});
      });
      container.appendChild(tapButton);
    });
  };

  if (el.readyState >= 1) onMeta();
  play();

  return () => {
    el.removeEventListener('loadedmetadata', onMeta);
    el.removeEventListener('timeupdate', onTime);
    el.removeEventListener('ended', onEnded);
    el.pause();
    el.removeAttribute('src');
    el.load();
    container.textContent = '';
  };
}

/** A row of bouncing bars, so an audio question is not a blank screen. */
function equalizer() {
  const wrap = document.createElement('div');
  wrap.className = 'eq';
  for (let i = 0; i < EQ_BARS; i++) {
    const bar = document.createElement('div');
    bar.className = 'eq__bar';
    bar.style.animationDelay = `${i * 110}ms`;
    bar.style.animationDuration = `${620 + ((i * 137) % 420)}ms`;
    wrap.appendChild(bar);
  }
  return wrap;
}
