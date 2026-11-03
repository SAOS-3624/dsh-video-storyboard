# References

What this project actually builds on. Two lists: **prior art we knowingly follow**, and **techniques we
re-implemented from first principles** (no code copied — see [CREDITS.md](../CREDITS.md)).

If a link rots, search the title; every entry here was checked against the source when written.

---

## 1. Shot boundary detection

**R. Lienhart, "Reliable Transition Detection in Videos: A Survey and Practitioner's Guide",
International Journal of Image and Graphics, 1(3), 2001.**
The canonical survey of cut/gradual-transition detection. Read this before inventing a scorer — most
"new" ideas (histogram distance, edge change ratio, twin comparison) are in it.

**T. Souček, J. Lokoč, "TransNet V2: An effective deep network architecture for fast shot transition
detection", arXiv:2008.04838, 2020.** <https://arxiv.org/abs/2008.04838>
State-of-the-art neural detector (F1 96.2 on BBC Planet Earth). We do **not** ship it — it needs a
TensorFlow/PyTorch runtime and weights, which is exactly the weight we refuse to add. It is listed here
as the accuracy ceiling: if you need gradual transitions (dissolves, wipes), use this instead of us.

**PySceneDetect — `ContentDetector`** (BSD-3-Clause) <https://www.scenedetect.com/>
Where the *idea* of weighting hue/saturation/value deltas separately comes from. Our `scan.js` is an
independent implementation (64×36 HSV, three-channel mean, no adaptive per-channel thresholding) that
diverges in four places, each forced by the material we score: hue is compared on a **ring** (359° vs 0°
is a 1° change, not a 359° one, otherwise red→magenta gradients register as a huge cut); the hue term is
**down-weighted by the lower of the two saturations** (near-grey pixels have no meaningful hue);
scores are **normalised by frame brightness** (×1–3) so one threshold means the same thing in a night
scene and a bright one; and **letterbox bars are measured and divided out** (they are a constant in the
denominator, which quietly depresses every score on a 2.39:1 film).

No PySceneDetect code is copied. If we ever lift a module wholesale (`FlashFilter` is the obvious
candidate), its BSD-3 notice and full licence text have to move into `NOTICE` first.

**A. Nagasaka, Y. Tanaka, "Automatic Video Indexing and Full-Video Search for Object Appearances",
Visual Database Systems II, 1992.**
The origin of the "count how many pixels changed by more than T, then threshold that ratio" formulation —
`scoreMode: 'mc'` is the same idea, with a per-cell tolerance for local motion and a mean-difference mode
kept as the default.

**H. J. Zhang, A. Kankanhalli, S. W. Smoliar, "Automatic Partitioning of Full-Motion Video",
Multimedia Systems 1(1), 1993.**
Region-based comparison instead of per-pixel, plus the two-threshold (dual-threshold) scheme for gradual
transitions. We tested the hysteresis variant on our two benchmarks: no net gain (SHOT 74.3 / BBC 89.2
vs 74.4 / 89.4), so it is not shipped — the numbers are in `bench/signal-processing.md`.

**B. Shahraray, "Scene Change Detection and Content-Based Sampling of Video Sequences", SPIE 2419, 1995.**
For each region, search a neighbourhood in the next frame for the best match *before* comparing — i.e.
motion compensation ahead of the difference. Our `mcRatioScore` is a simplified, downscaled version
(single-cell search within ±2 cells at 64×36, early exit on the first match under τ), not a port of it.

**Robust normalisation (median / IQR).** `normalize: 'z'` scales the per-frame score by
"how many times the local noise level" instead of an absolute number: `z = (s − rolling median) / (IQR/1.349)`,
where `IQR/1.349` is the normal-consistent σ estimate. Median and IQR are chosen over mean/σ because a
flash is an outlier and would inflate a standard deviation. Standard robust statistics (see
P. J. Rousseeuw, C. Croux, "Alternatives to the Median Absolute Deviation", JASA 88(424), 1993);
the implementation here is 20 lines of histogram quantiles, no external code.

**FFmpeg `scdet` filter** <https://ffmpeg.org/ffmpeg-filters.html#scdet>
The baseline we benchmark against in the README: 4/9 hard cuts on our fixture versus our 9/9. `scdet`
scores mean absolute frame difference, so a cut that swaps hue at equal luma is invisible to it.

---

## 2. Non-uniform sampling (why "one cut per 1.5 s" is not a hack)

**B. Korbar, D. Tran, L. Torresani, "SCSampler: Sampling Salient Clips from Video for Efficient Action
Recognition", ICCV 2019, arXiv:1904.04289.** <https://arxiv.org/abs/1904.04289>
The formal statement of what this project does at a much smaller scale: pick **K** clips by a cheap
saliency score instead of sampling uniformly, and both accuracy and cost improve (they report +7 % and
>15× less compute on Sports1M). Our density curve is a hand-built saliency score over cut rate; theirs is
learned. We cite it because it makes the same argument — **uniform sampling is not neutral, it is a
choice that discards the parts of the video that change**.

**Inverse-CDF sampling.** Placing cell boundaries at equal increments of a density integral is inverse
transform sampling applied to the time axis. Nothing novel is claimed here.

---

## 3. Frame selection inside a segment

**J. L. Pech-Pacheco, G. Cristóbal, J. Chamorro-Martínez, J. Fernández-Valdivia, "Diatom autofocusing in
brightfield microscopy: a comparative study", ICPR 2000.**
The origin of **variance of the Laplacian** as a focus measure — the metric behind `--pick sharp`.
It is a 25-year-old, 10-line metric that beats `ffmpeg`'s `thumbnail` filter on the one case that matters
here: a segment that fades from blurry to sharp (a histogram is blind to blur).

---

## 4. Loudness

**ITU-R BS.1770-4**, "Algorithms to measure audio programme loudness and true-peak audio level".
**EBU Tech 3341**, "Loudness Metering: 'EBU Mode' metering to supplement EBU R 128".
Implemented by FFmpeg's `ebur128` and `silencedetect` filters, which we call as external processes.

---

## 5. Speech recognition

**FunAudioLLM team, "FunAudioLLM: Voice Understanding and Generation Foundation Models for Natural
Interaction Between Humans and LLMs", arXiv:2407.04051, 2024.** <https://arxiv.org/abs/2407.04051>
Covers SenseVoice (ASR + language ID + speech emotion + audio event detection) and CosyVoice.
SenseVoice-Small is the default endpoint model this tool points at; it is non-autoregressive and reports
~70 ms for 10 s of audio. **Timestamp support landed in 2024-11 via CTC alignment** — earlier builds
returned one text blob with no timings, which is why this project also accepts a plain subtitle track
and chunks requests itself.

**OpenAI `/audio/transcriptions` (verbose_json)** — the wire format we speak, so any
OpenAI-compatible server (FunASR wrappers, whisper-server, speaches, SiliconFlow) works unchanged.
See [asr-contract.md](./asr-contract.md).

---

## 6. Evaluation datasets

The accuracy numbers quoted in the README are measured on these public sets, using the protocol of
TransNetV2's `training/metrics_utils.py` (scene lists → transition intervals, 2-frame tolerance). We
download the videos locally to measure; **this project does not redistribute either dataset** — only the
benchmark scripts under `bench/` are ours.

**L. Baraldi, C. Grana, R. Cucchiara, "Shot and Scene Detection via Hierarchical Clustering for
Re-visited TV Material", CAIP 2015.**
BBC Planet Earth (11 episodes, 4844 shot transitions) and RAI (10 items, ~98 min, scene-level labels
only — do not score a shot detector on it). The BBC set is what the **F1 90.2** refers to. Note when
quoting it: 96 % of its transitions are hard cuts, which flatters every frame-difference detector.
RAI's mirror we used carries semantic *scene* annotations rather than shot labels; scoring SBD against
it yields a meaningless ~15 % F1, so it is not used for any published number.

**W. Zhu, Y. Huang, X. Xie, W. Liu, J. Deng, D. Zhang, Z. Wang, J. Liu, "AutoShot: A Short Video Dataset
and State-of-the-Art Shot Boundary Detection", CVPRW 2023, arXiv:2304.06116.**
SHOT (200 test videos, 2516 transitions, median shot ≈1.6 s). This is the hard set — short-form video
cuts between visually similar frames, and our F1 there is **69.8 %**. Quote 90.2 and 69.8 together, never
90 alone.

---

## 7. Deliberately not used

| Technique | Why not |
|---|---|
| TransNet V2 / deep SBD | needs a DL runtime + weights; we refuse both |
| Music/emotion models (MERT, CLAP, Qwen-Audio) | license and size; loudness is a *measurement*, not understanding, and we say so |
| Learned saliency (SCSampler-style) | a 20-line cut-rate curve gets most of the benefit at zero model cost |
| Optical-flow-based cut detection | 10–50× the compute for a marginal gain over HSV difference |
