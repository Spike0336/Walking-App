let writeQueue = Promise.resolve();

function send(cmdBytes) {
  writeQueue = writeQueue.then(() => {
    return new Promise((resolve) => {
      if (!txCharacteristic) return resolve();
      
      txCharacteristic.writeValueWithoutResponse(cmdBytes)
        .then(() => setTimeout(resolve, 30)) // 30ms gap to let GATT settle
        .catch((err) => {
          log('BLE Write Error: ' + err.message);
          resolve();
        });
    });
  });
  return writeQueue;
}