(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LivePreviewState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function beginRun(state) {
    return {
      ...state,
      sourcePreview: null,
      clips: [],
      activeClip: -1,
      currentPreviewIdx: -1,
    };
  }

  function setSourcePreview(state, preview) {
    return { ...state, sourcePreview: preview || null };
  }

  function setCandidates(state, candidates) {
    const previous = new Map((state.clips || []).map(c => [c.candidateId, c]));
    return {
      ...state,
      sourcePreview: null,
      clips: (candidates || []).map((candidate, i) => ({
        ...previous.get(candidate.candidateId),
        ...candidate,
        index: i + 1,
        state: candidate.state || 'waiting',
      })),
    };
  }

  function setCandidateState(state, update) {
    if (!update?.candidateId) return state;
    return {
      ...state,
      clips: (state.clips || []).map(c =>
        c.candidateId === update.candidateId ? { ...c, ...update } : c),
    };
  }

  function completeClip(state, clip) {
    const clips = state.clips || [];
    const found = clips.some(c => c.candidateId === clip.candidateId);
    return {
      ...state,
      clips: found
        ? clips.map(c => c.candidateId === clip.candidateId
          ? { ...c, ...clip, state: 'ready' }
          : c)
        : [...clips, { ...clip, state: 'ready' }],
    };
  }

  return { beginRun, setSourcePreview, setCandidates, setCandidateState, completeClip };
});
