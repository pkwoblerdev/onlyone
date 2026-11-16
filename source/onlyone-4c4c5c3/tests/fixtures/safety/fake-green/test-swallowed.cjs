const assert = require('node:assert')

function a () { try { return 1 } catch {} }
function b () { try { return 2 } catch { } }
function c () { try { return 3 } catch (e) {} }
