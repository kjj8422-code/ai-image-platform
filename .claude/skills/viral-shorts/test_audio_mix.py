import unittest
import numpy as np
from audio_mix import bed_envelope, bed_gain, cue_window, apply_bed_envelope


class AudioMixTests(unittest.TestCase):
    def test_late_cue_never_spills_into_next_scene(self):
        for duration in (.1, 1, 3, 6):
            for timing in ('start', 'middle', 'end', 'invalid'):
                offset, length = cue_window({'duration': duration, 'sfxTiming': timing}, 8)
                self.assertGreaterEqual(offset, 0)
                self.assertLessEqual(offset+length, duration)
        self.assertEqual(cue_window({'duration': 4, 'sfxTiming': 'end'}, .5), (3.5,.5))

    def test_legacy_board_and_full_scene_environment(self):
        self.assertEqual(cue_window({'duration': 4}, .7), (0,.7))
        self.assertEqual(cue_window({'duration': 4, 'sfx': 'rain', 'sfxTiming': 'end'}, .7), (0,4))

    def test_music_ducks_for_voice_and_recovers_in_photo_hold(self):
        scenes=[{'start':0,'duration':4,'voice_duration':2}, {'start':4,'duration':4,'voice_duration':2}]
        gain=bed_envelope(np.array([0,1,3,4,5,7,8]),scenes,8)
        np.testing.assert_allclose(gain,[0,.4,1,.4,.4,1,0])
        self.assertAlmostEqual(float(bed_envelope(2.125,scenes,8)), .7)

    def test_normalization_limits_extreme_boost(self):
        self.assertEqual(bed_gain(0),1)
        self.assertEqual(bed_gain(.0001),4)
        self.assertAlmostEqual(bed_gain(.5)*.5,.045)

    def test_actual_moviepy_scalar_and_stereo_frames(self):
        from moviepy import AudioClip
        source=AudioClip(lambda t: np.ones((len(t),2)) if np.ndim(t) else np.ones(2),duration=4,fps=44100)
        mixed=apply_bed_envelope(source,[{'start':0,'duration':4,'voice_duration':2}],4)
        np.testing.assert_allclose(mixed.get_frame(1), [.4,.4])
        np.testing.assert_allclose(mixed.get_frame(np.array([1.,3.])), [[.4,.4],[1,1]])
        source.close(); mixed.close()


if __name__ == '__main__': unittest.main()
