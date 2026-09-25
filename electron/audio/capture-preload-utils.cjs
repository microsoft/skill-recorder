function serializeError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error && typeof error.name === "string" ? error.name : "",
  };
}

function handleRecorderStop({ sendChain, id, getStopEpoch, cleanup, send }) {
  return sendChain
    .then(() => {
      const stopEpoch = getStopEpoch();
      cleanup();
      send("audio:stopped", id, stopEpoch);
    })
    .catch((error) => {
      const stopEpoch = getStopEpoch();
      cleanup();
      const detail = serializeError(error);
      send("audio:error", id, detail.message, detail.name);
      send("audio:stopped", id, stopEpoch);
    });
}

module.exports = { handleRecorderStop, serializeError };
