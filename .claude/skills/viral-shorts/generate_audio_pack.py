"""Rebuild the original synthesized audio pack (no samples or external recordings).

Requires numpy and imageio-ffmpeg. Existing third-party audio is never overwritten.
Music: 8 bars, with chords, bass, melody and style-specific percussion.
Effects/ambiences are intentionally stylized, not field recordings.
"""
from pathlib import Path
import subprocess

import imageio_ffmpeg
import numpy as np

SR = 44100
OUT = Path(__file__).parent / "assets"


def tone(midi, seconds, style="keys"):
    t = np.arange(round(seconds * SR)) / SR
    f = 440 * 2 ** ((midi - 69) / 12)
    if style == "chip":
        y = sum(np.sin(2*np.pi*f*k*t)/k for k in (1, 3, 5, 7))
        env = np.exp(-t*4)
    elif style == "pad":
        y = sum(np.sin(2*np.pi*(f*k + d)*t)/k for k,d in ((1,0),(2,.4),(3,-.3)))
        env = np.minimum(t/.2, 1) * np.minimum((seconds-t)/.3, 1)
    else:
        ratios = (1, 2.01, 3.99) if style == "bell" else (1, 2, 3)
        y = sum(np.sin(2*np.pi*f*k*t)*a*np.exp(-t*d) for k,a,d in zip(ratios,(1,.35,.12),(2.5,5,8)))
        env = np.exp(-t*(4 if style == "pluck" else .6))
    return y * env * np.minimum(t/.008, 1) * np.minimum((seconds-t)/.035, 1)


def add(buf, sound, at, gain=1):
    start = round(at*SR)
    n = min(len(sound), len(buf)-start)
    if n > 0: buf[start:start+n] += sound[:n]*gain


def noise(seconds, rng, smooth=1):
    y = rng.normal(0, 1, round(seconds*SR))
    if smooth > 1: y = np.convolve(y, np.ones(smooth)/smooth, mode="same")
    return y


def drum(kind, rng):
    t = np.arange(round(.25*SR))/SR
    if kind == "kick": return np.sin(2*np.pi*(48*t+7*(1-np.exp(-t*35))))*np.exp(-t*22)
    return noise(.25,rng,3 if kind == "snare" else 1)*np.exp(-t*(30 if kind == "snare" else 100))


# Each score has its own tempo, harmony, timbre and melodic contour.
SCORES = {
    "horror": (62, [45,46,45,43], [0,3,7], "pad", [0,1,7,3], False),
    "sad": (70, [57,53,48,55], [0,3,7], "keys", [7,3,0,2,3,0,-2,0], False),
    "upbeat": (116, [48,55,57,53], [0,4,7], "pluck", [0,4,7,12,7,4,9,7], True),
    "chill": (78, [50,55,48,53], [0,3,7,10], "keys", [7,10,7,3,0,3,5,3], True),
    "action": (138, [45,45,41,43], [0,3,7], "chip", [0,0,7,0,3,0,10,7], True),
    "retro": (124, [48,53,55,48], [0,4,7], "chip", [0,7,12,16,12,7,4,7], True),
    "warm": (88, [48,53,57,55], [0,4,7,11], "pluck", [4,7,12,7,9,7,4,0], False),
    "romantic": (72, [53,58,50,55], [0,4,7], "bell", [12,7,4,7,9,7,4,0], False),
    "travel": (104, [48,55,53,55], [0,4,7], "bell", [0,7,9,7,4,0,4,7], True),
    "documentary": (92, [50,53,48,55], [0,7,12], "keys", [0,7,3,7,0,7,5,7], False),
    "inspiring": (96, [48,55,57,53], [0,4,7], "pad", [0,4,7,12,14,12,7,4], True),
    "comedy": (108, [48,53,50,55], [0,4,7], "pluck", [0,12,4,7,1,7,4,-5], True),
}


def music(name, score):
    bpm, roots, chord, style, melody, drums = score
    beat = 60/bpm
    seconds = 32*beat
    y = np.zeros(round(seconds*SR))
    rng = np.random.default_rng(list(SCORES).index(name)+400)
    for bar in range(8):
        root = roots[bar % 4]
        start = bar*4*beat
        for n in chord: add(y,tone(root+n,4*beat,"pad"),start,.035)
        for b in (0,2): add(y,tone(root-12,beat*1.4,"keys"),start+b*beat,.14)
        for step in range(8):
            # Rest on alternate offbeats in the gentler scores.
            if not drums and step % 2: continue
            note = root+12+melody[(step+bar//4*2) % len(melody)]
            add(y,tone(note,beat*.85,style),start+step*.5*beat,.055 if style=="pad" else .1)
        if drums:
            for b in (0,2): add(y,drum("kick",rng),start+b*beat,.18)
            for b in (1,3): add(y,drum("snare",rng),start+b*beat,.055)
            for b in range(8): add(y,drum("hat",rng),start+b*.5*beat,.022)
    return y


def effects():
    rng = np.random.default_rng(8422)
    result = {}
    for name,secs,up in [("riser",1.8,True),("downer",1.1,False),("swipe",.25,True),("soft_whoosh",.7,True)]:
        t = np.arange(round(secs*SR))/SR
        env = np.sin(np.pi*t/secs)**1.5
        sweep = np.sin(2*np.pi*(130*t+(700 if up else -60)*t*t))
        result[name] = env*(noise(secs,rng,8)*.5+sweep*.12)
    for name,notes in [("success",[72,76,79]),("glimmer",[84,91,88,96])]:
        y=np.zeros(SR*2)
        for i,n in enumerate(notes): add(y,tone(n,.9,"bell"),i*.15,.3)
        result[name]=y
    for name,times in [("shutter",[0,.08]),("typing",[0,.09,.22,.3,.48,.57]),("ticking",[0,.5,1,1.5])]:
        y=np.zeros(round((max(times)+.15)*SR))
        for at in times:
            t=np.arange(round(.07*SR))/SR
            add(y,noise(.07,rng,2)*np.exp(-t*90),at,.5)
        result[name]=y
    y=np.zeros(SR*2)
    for at in (0,.18,.9,1.08): add(y,tone(33,.18,"keys"),at,.6)
    result['heartbeat']=y
    seconds=8
    t=np.arange(SR*seconds)/SR
    result['rain']=noise(seconds,rng,3)*.13+noise(seconds,rng,40)*.3
    result['wind']=noise(seconds,rng,160)*(1+.5*np.sin(2*np.pi*.24*t))
    result['waves']=noise(seconds,rng,22)*(.3+.7*(.5+.5*np.sin(2*np.pi*.22*t))**2)
    y=noise(seconds,rng,70)*.03
    for at in (0.3,1.2,1.5,3,4.4,4.8,6.2,7.1):
        tt=np.arange(round(.23*SR))/SR
        add(y,np.sin(2*np.pi*(2200*tt+1800*tt**2))*np.sin(np.pi*tt/.23)**2,at,.09)
    result['birds']=y
    y=noise(seconds,rng,40)*.18
    for at in rng.uniform(0,7.9,60):
        tt=np.arange(round(.05*SR))/SR
        add(y,noise(.05,rng)*np.exp(-tt*170),at,rng.uniform(.03,.15))
    result['fire']=y
    result['night']=np.sin(2*np.pi*3800*t)*np.maximum(0,np.sin(2*np.pi*3*t))**12*.07+noise(seconds,rng,90)*.025
    return result


def save(kind,name,y):
    # Short edge ramps remove clicks; final video mixer handles full fade and ducking.
    ramp=min(round(.025*SR),len(y)//2)
    y[:ramp]*=np.linspace(0,1,ramp); y[-ramp:]*=np.linspace(1,0,ramp)
    y=y/max(np.max(np.abs(y)),1e-6)*.7
    target=OUT/kind/f'{name}.mp3'
    target.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-y',
        '-f','s16le','-ar',str(SR),'-ac','1','-i','pipe:0',
        '-af','loudnorm=I=-18:TP=-2:LRA=9','-ar',str(SR),'-b:a','128k',str(target),
    ],input=(y*32767).astype('<i2').tobytes(),check=True)
    print(f'{kind}/{name}: {len(y)/SR:.2f}s')


if __name__ == '__main__':
    for name,score in SCORES.items(): save('bgm',name,music(name,score))
    for name,y in effects().items(): save('sfx',name,y)
