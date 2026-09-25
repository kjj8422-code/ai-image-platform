"""Timing and gain envelopes shared by the photo-shorts audio renderer and tests."""
import json
from pathlib import Path

import numpy as np

CATALOG = Path(__file__).resolve().parents[3] / 'src/lib/audioCatalog.json'
BED_CUES = {
    e['cue'] for e in json.loads(CATALOG.read_text(encoding='utf-8'))['sfx']
    if e.get('playback') == 'bed'
}


def cue_window(scene, clip_duration):
    """Keep even late cues wholly inside the scene; old boards start at zero."""
    duration = max(0, float(scene['duration']))
    if scene.get('sfx') in BED_CUES:
        return 0.0, duration
    length = min(max(0, clip_duration), 2.0, duration)
    timing = scene.get('sfxTiming', 'start')
    offset = {'middle': (duration-length)/2, 'end': duration-length}.get(timing, 0.0)
    return offset, length


def bed_envelope(t, scenes, total_duration):
    """Smooth -8dB duck during speech; recover gradually in held photo pauses.

    Works with scalar and vector MoviePy times. Uses the actual synthesized
    narration durations saved by hold_short_scenes, not estimated text lengths.
    """
    times = np.asarray(t, dtype=float)
    duck = np.zeros_like(times)
    for scene in scenes:
        start = float(scene['start'])
        end = start + min(float(scene.get('voice_duration', scene['duration'])), float(scene['duration']))
        if end <= start: continue
        attack = np.clip((times-(start-.08))/.08, 0, 1)
        release = np.clip((end+.25-times)/.25, 0, 1)
        duck = np.maximum(duck, np.minimum(attack, release))
    gain = 1 - .60*duck
    fade = np.minimum(np.clip(times/.25, 0, 1), np.clip((total_duration-times)/.55, 0, 1))
    return gain*fade


def apply_bed_envelope(clip, scenes, total_duration):
    def transform(get_frame, t):
        frames = get_frame(t)
        gain = bed_envelope(t, scenes, total_duration)
        if np.ndim(frames) == 2 and np.ndim(gain) == 1:
            gain = gain[:, None]
        return frames*gain
    return clip.transform(transform)


def bed_gain(rms, target=.045):
    return min(target/rms, 4.0) if rms > 1e-6 else 1.0
