Protocol-1 multiplayer code, frozen.

These are byte-for-byte copies of src/net/net.js, src/net/room.js,
src/net/protocol.js and server/worker.js from branch main at 613ed6e -- the
code every kid with a cached page is running, and the room the live Worker
serves today. The one edit: worker.js imports './protocol.js' instead of
'../src/net/protocol.js', so it resolves inside this folder.

tools/netcheck.mjs uses them two ways:

  - as the OLD CLIENT, to prove the new server still lets a protocol-1 page
    join, send and receive snapshots after the Worker is redeployed; and
  - as the OLD SERVER, to prove a new page still works if it reaches a Worker
    that has not been redeployed yet;
  - and as the "before" in the smoothness comparison.

Never edit these to make a check pass. They are what is in the wild.
