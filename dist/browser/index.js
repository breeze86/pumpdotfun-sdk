import { PublicKey, Transaction, ComputeBudgetProgram, SendTransactionError, TransactionMessage, VersionedTransaction, TransactionInstruction } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';
import { struct, u64, bool, publicKey } from '@coral-xyz/borsh';
import { getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction } from '@solana/spl-token';

class GlobalAccount {
    discriminator;
    initialized = false;
    authority;
    feeRecipient;
    initialVirtualTokenReserves;
    initialVirtualSolReserves;
    initialRealTokenReserves;
    tokenTotalSupply;
    feeBasisPoints;
    constructor(discriminator, initialized, authority, feeRecipient, initialVirtualTokenReserves, initialVirtualSolReserves, initialRealTokenReserves, tokenTotalSupply, feeBasisPoints) {
        this.discriminator = discriminator;
        this.initialized = initialized;
        this.authority = authority;
        this.feeRecipient = feeRecipient;
        this.initialVirtualTokenReserves = initialVirtualTokenReserves;
        this.initialVirtualSolReserves = initialVirtualSolReserves;
        this.initialRealTokenReserves = initialRealTokenReserves;
        this.tokenTotalSupply = tokenTotalSupply;
        this.feeBasisPoints = feeBasisPoints;
    }
    getInitialBuyPrice(amount) {
        if (amount <= 0n) {
            return 0n;
        }
        let n = this.initialVirtualSolReserves * this.initialVirtualTokenReserves;
        let i = this.initialVirtualSolReserves + amount;
        let r = n / i + 1n;
        let s = this.initialVirtualTokenReserves - r;
        return s < this.initialRealTokenReserves
            ? s
            : this.initialRealTokenReserves;
    }
    static fromBuffer(buffer) {
        const structure = struct([
            u64("discriminator"),
            bool("initialized"),
            publicKey("authority"),
            publicKey("feeRecipient"),
            u64("initialVirtualTokenReserves"),
            u64("initialVirtualSolReserves"),
            u64("initialRealTokenReserves"),
            u64("tokenTotalSupply"),
            u64("feeBasisPoints"),
        ]);
        let value = structure.decode(buffer);
        return new GlobalAccount(BigInt(value.discriminator), value.initialized, value.authority, value.feeRecipient, BigInt(value.initialVirtualTokenReserves), BigInt(value.initialVirtualSolReserves), BigInt(value.initialRealTokenReserves), BigInt(value.tokenTotalSupply), BigInt(value.feeBasisPoints));
    }
}

function toCreateEvent(event) {
    return {
        name: event.name,
        symbol: event.symbol,
        uri: event.uri,
        mint: new PublicKey(event.mint),
        bondingCurve: new PublicKey(event.bondingCurve),
        user: new PublicKey(event.user),
    };
}
function toCompleteEvent(event) {
    return {
        user: new PublicKey(event.user),
        mint: new PublicKey(event.mint),
        bondingCurve: new PublicKey(event.bondingCurve),
        timestamp: Number(event.timestamp),
    };
}
function toTradeEvent(event) {
    return {
        mint: new PublicKey(event.mint),
        solAmount: BigInt(event.solAmount),
        tokenAmount: BigInt(event.tokenAmount),
        isBuy: event.isBuy,
        user: new PublicKey(event.user),
        timestamp: Number(event.timestamp),
        virtualSolReserves: BigInt(event.virtualSolReserves),
        virtualTokenReserves: BigInt(event.virtualTokenReserves),
        realSolReserves: BigInt(event.realSolReserves),
        realTokenReserves: BigInt(event.realTokenReserves),
    };
}
function toSetParamsEvent(event) {
    return {
        feeRecipient: new PublicKey(event.feeRecipient),
        initialVirtualTokenReserves: BigInt(event.initialVirtualTokenReserves),
        initialVirtualSolReserves: BigInt(event.initialVirtualSolReserves),
        initialRealTokenReserves: BigInt(event.initialRealTokenReserves),
        tokenTotalSupply: BigInt(event.tokenTotalSupply),
        feeBasisPoints: BigInt(event.feeBasisPoints),
    };
}

class BondingCurveAccount {
    discriminator;
    virtualTokenReserves;
    virtualSolReserves;
    realTokenReserves;
    realSolReserves;
    tokenTotalSupply;
    complete;
    constructor(discriminator, virtualTokenReserves, virtualSolReserves, realTokenReserves, realSolReserves, tokenTotalSupply, complete) {
        this.discriminator = discriminator;
        this.virtualTokenReserves = virtualTokenReserves;
        this.virtualSolReserves = virtualSolReserves;
        this.realTokenReserves = realTokenReserves;
        this.realSolReserves = realSolReserves;
        this.tokenTotalSupply = tokenTotalSupply;
        this.complete = complete;
    }
    getBuyPrice(amount) {
        if (this.complete) {
            throw new Error("Curve is complete");
        }
        if (amount <= 0n) {
            return 0n;
        }
        // Calculate the product of virtual reserves
        let n = this.virtualSolReserves * this.virtualTokenReserves;
        // Calculate the new virtual sol reserves after the purchase
        let i = this.virtualSolReserves + amount;
        // Calculate the new virtual token reserves after the purchase
        let r = n / i + 1n;
        // Calculate the amount of tokens to be purchased
        let s = this.virtualTokenReserves - r;
        // Return the minimum of the calculated tokens and real token reserves
        return s < this.realTokenReserves ? s : this.realTokenReserves;
    }
    getSellPrice(amount, feeBasisPoints) {
        if (this.complete) {
            throw new Error("Curve is complete");
        }
        if (amount <= 0n) {
            return 0n;
        }
        // Calculate the proportional amount of virtual sol reserves to be received
        let n = (amount * this.virtualSolReserves) / (this.virtualTokenReserves + amount);
        // Calculate the fee amount in the same units
        let a = (n * feeBasisPoints) / 10000n;
        // Return the net amount after deducting the fee
        return n - a;
    }
    getMarketCapSOL() {
        if (this.virtualTokenReserves === 0n) {
            return 0n;
        }
        return ((this.tokenTotalSupply * this.virtualSolReserves) /
            this.virtualTokenReserves);
    }
    getFinalMarketCapSOL(feeBasisPoints) {
        let totalSellValue = this.getBuyOutPrice(this.realTokenReserves, feeBasisPoints);
        let totalVirtualValue = this.virtualSolReserves + totalSellValue;
        let totalVirtualTokens = this.virtualTokenReserves - this.realTokenReserves;
        if (totalVirtualTokens === 0n) {
            return 0n;
        }
        return (this.tokenTotalSupply * totalVirtualValue) / totalVirtualTokens;
    }
    getBuyOutPrice(amount, feeBasisPoints) {
        let solTokens = amount < this.virtualTokenReserves ? this.virtualTokenReserves : amount;
        let totalSellValue = (solTokens * this.virtualSolReserves) /
            (this.virtualTokenReserves - solTokens) +
            1n;
        let fee = (totalSellValue * feeBasisPoints) / 10000n;
        return totalSellValue + fee;
    }
    static fromBuffer(buffer) {
        const structure = struct([
            u64("discriminator"),
            u64("virtualTokenReserves"),
            u64("virtualSolReserves"),
            u64("realTokenReserves"),
            u64("realSolReserves"),
            u64("tokenTotalSupply"),
            bool("complete"),
        ]);
        let value = structure.decode(buffer);
        return new BondingCurveAccount(BigInt(value.discriminator), BigInt(value.virtualTokenReserves), BigInt(value.virtualSolReserves), BigInt(value.realTokenReserves), BigInt(value.realSolReserves), BigInt(value.tokenTotalSupply), value.complete);
    }
}

function getAugmentedNamespace(n) {
  if (Object.prototype.hasOwnProperty.call(n, '__esModule')) return n;
  var f = n.default;
	if (typeof f == "function") {
		var a = function a () {
			if (this instanceof a) {
        return Reflect.construct(f, arguments, this.constructor);
			}
			return f.apply(this, arguments);
		};
		a.prototype = f.prototype;
  } else a = {};
  Object.defineProperty(a, '__esModule', {value: true});
	Object.keys(n).forEach(function (k) {
		var d = Object.getOwnPropertyDescriptor(n, k);
		Object.defineProperty(a, k, d.get ? d : {
			enumerable: true,
			get: function () {
				return n[k];
			}
		});
	});
	return a;
}

var bn$1 = {exports: {}};

var _nodeResolve_empty = {};

var _nodeResolve_empty$1 = /*#__PURE__*/Object.freeze({
    __proto__: null,
    default: _nodeResolve_empty
});

var require$$0 = /*@__PURE__*/getAugmentedNamespace(_nodeResolve_empty$1);

var bn = bn$1.exports;

var hasRequiredBn;

function requireBn () {
	if (hasRequiredBn) return bn$1.exports;
	hasRequiredBn = 1;
	(function (module) {
		(function (module, exports) {

		  // Utils
		  function assert (val, msg) {
		    if (!val) throw new Error(msg || 'Assertion failed');
		  }

		  // Could use `inherits` module, but don't want to move from single file
		  // architecture yet.
		  function inherits (ctor, superCtor) {
		    ctor.super_ = superCtor;
		    var TempCtor = function () {};
		    TempCtor.prototype = superCtor.prototype;
		    ctor.prototype = new TempCtor();
		    ctor.prototype.constructor = ctor;
		  }

		  // BN

		  function BN (number, base, endian) {
		    if (BN.isBN(number)) {
		      return number;
		    }

		    this.negative = 0;
		    this.words = null;
		    this.length = 0;

		    // Reduction context
		    this.red = null;

		    if (number !== null) {
		      if (base === 'le' || base === 'be') {
		        endian = base;
		        base = 10;
		      }

		      this._init(number || 0, base || 10, endian || 'be');
		    }
		  }
		  if (typeof module === 'object') {
		    module.exports = BN;
		  } else {
		    exports.BN = BN;
		  }

		  BN.BN = BN;
		  BN.wordSize = 26;

		  var Buffer;
		  try {
		    if (typeof window !== 'undefined' && typeof window.Buffer !== 'undefined') {
		      Buffer = window.Buffer;
		    } else {
		      Buffer = require$$0.Buffer;
		    }
		  } catch (e) {
		  }

		  BN.isBN = function isBN (num) {
		    if (num instanceof BN) {
		      return true;
		    }

		    return num !== null && typeof num === 'object' &&
		      num.constructor.wordSize === BN.wordSize && Array.isArray(num.words);
		  };

		  BN.max = function max (left, right) {
		    if (left.cmp(right) > 0) return left;
		    return right;
		  };

		  BN.min = function min (left, right) {
		    if (left.cmp(right) < 0) return left;
		    return right;
		  };

		  BN.prototype._init = function init (number, base, endian) {
		    if (typeof number === 'number') {
		      return this._initNumber(number, base, endian);
		    }

		    if (typeof number === 'object') {
		      return this._initArray(number, base, endian);
		    }

		    if (base === 'hex') {
		      base = 16;
		    }
		    assert(base === (base | 0) && base >= 2 && base <= 36);

		    number = number.toString().replace(/\s+/g, '');
		    var start = 0;
		    if (number[0] === '-') {
		      start++;
		      this.negative = 1;
		    }

		    if (start < number.length) {
		      if (base === 16) {
		        this._parseHex(number, start, endian);
		      } else {
		        this._parseBase(number, base, start);
		        if (endian === 'le') {
		          this._initArray(this.toArray(), base, endian);
		        }
		      }
		    }
		  };

		  BN.prototype._initNumber = function _initNumber (number, base, endian) {
		    if (number < 0) {
		      this.negative = 1;
		      number = -number;
		    }
		    if (number < 0x4000000) {
		      this.words = [number & 0x3ffffff];
		      this.length = 1;
		    } else if (number < 0x10000000000000) {
		      this.words = [
		        number & 0x3ffffff,
		        (number / 0x4000000) & 0x3ffffff
		      ];
		      this.length = 2;
		    } else {
		      assert(number < 0x20000000000000); // 2 ^ 53 (unsafe)
		      this.words = [
		        number & 0x3ffffff,
		        (number / 0x4000000) & 0x3ffffff,
		        1
		      ];
		      this.length = 3;
		    }

		    if (endian !== 'le') return;

		    // Reverse the bytes
		    this._initArray(this.toArray(), base, endian);
		  };

		  BN.prototype._initArray = function _initArray (number, base, endian) {
		    // Perhaps a Uint8Array
		    assert(typeof number.length === 'number');
		    if (number.length <= 0) {
		      this.words = [0];
		      this.length = 1;
		      return this;
		    }

		    this.length = Math.ceil(number.length / 3);
		    this.words = new Array(this.length);
		    for (var i = 0; i < this.length; i++) {
		      this.words[i] = 0;
		    }

		    var j, w;
		    var off = 0;
		    if (endian === 'be') {
		      for (i = number.length - 1, j = 0; i >= 0; i -= 3) {
		        w = number[i] | (number[i - 1] << 8) | (number[i - 2] << 16);
		        this.words[j] |= (w << off) & 0x3ffffff;
		        this.words[j + 1] = (w >>> (26 - off)) & 0x3ffffff;
		        off += 24;
		        if (off >= 26) {
		          off -= 26;
		          j++;
		        }
		      }
		    } else if (endian === 'le') {
		      for (i = 0, j = 0; i < number.length; i += 3) {
		        w = number[i] | (number[i + 1] << 8) | (number[i + 2] << 16);
		        this.words[j] |= (w << off) & 0x3ffffff;
		        this.words[j + 1] = (w >>> (26 - off)) & 0x3ffffff;
		        off += 24;
		        if (off >= 26) {
		          off -= 26;
		          j++;
		        }
		      }
		    }
		    return this._strip();
		  };

		  function parseHex4Bits (string, index) {
		    var c = string.charCodeAt(index);
		    // '0' - '9'
		    if (c >= 48 && c <= 57) {
		      return c - 48;
		    // 'A' - 'F'
		    } else if (c >= 65 && c <= 70) {
		      return c - 55;
		    // 'a' - 'f'
		    } else if (c >= 97 && c <= 102) {
		      return c - 87;
		    } else {
		      assert(false, 'Invalid character in ' + string);
		    }
		  }

		  function parseHexByte (string, lowerBound, index) {
		    var r = parseHex4Bits(string, index);
		    if (index - 1 >= lowerBound) {
		      r |= parseHex4Bits(string, index - 1) << 4;
		    }
		    return r;
		  }

		  BN.prototype._parseHex = function _parseHex (number, start, endian) {
		    // Create possibly bigger array to ensure that it fits the number
		    this.length = Math.ceil((number.length - start) / 6);
		    this.words = new Array(this.length);
		    for (var i = 0; i < this.length; i++) {
		      this.words[i] = 0;
		    }

		    // 24-bits chunks
		    var off = 0;
		    var j = 0;

		    var w;
		    if (endian === 'be') {
		      for (i = number.length - 1; i >= start; i -= 2) {
		        w = parseHexByte(number, start, i) << off;
		        this.words[j] |= w & 0x3ffffff;
		        if (off >= 18) {
		          off -= 18;
		          j += 1;
		          this.words[j] |= w >>> 26;
		        } else {
		          off += 8;
		        }
		      }
		    } else {
		      var parseLength = number.length - start;
		      for (i = parseLength % 2 === 0 ? start + 1 : start; i < number.length; i += 2) {
		        w = parseHexByte(number, start, i) << off;
		        this.words[j] |= w & 0x3ffffff;
		        if (off >= 18) {
		          off -= 18;
		          j += 1;
		          this.words[j] |= w >>> 26;
		        } else {
		          off += 8;
		        }
		      }
		    }

		    this._strip();
		  };

		  function parseBase (str, start, end, mul) {
		    var r = 0;
		    var b = 0;
		    var len = Math.min(str.length, end);
		    for (var i = start; i < len; i++) {
		      var c = str.charCodeAt(i) - 48;

		      r *= mul;

		      // 'a'
		      if (c >= 49) {
		        b = c - 49 + 0xa;

		      // 'A'
		      } else if (c >= 17) {
		        b = c - 17 + 0xa;

		      // '0' - '9'
		      } else {
		        b = c;
		      }
		      assert(c >= 0 && b < mul, 'Invalid character');
		      r += b;
		    }
		    return r;
		  }

		  BN.prototype._parseBase = function _parseBase (number, base, start) {
		    // Initialize as zero
		    this.words = [0];
		    this.length = 1;

		    // Find length of limb in base
		    for (var limbLen = 0, limbPow = 1; limbPow <= 0x3ffffff; limbPow *= base) {
		      limbLen++;
		    }
		    limbLen--;
		    limbPow = (limbPow / base) | 0;

		    var total = number.length - start;
		    var mod = total % limbLen;
		    var end = Math.min(total, total - mod) + start;

		    var word = 0;
		    for (var i = start; i < end; i += limbLen) {
		      word = parseBase(number, i, i + limbLen, base);

		      this.imuln(limbPow);
		      if (this.words[0] + word < 0x4000000) {
		        this.words[0] += word;
		      } else {
		        this._iaddn(word);
		      }
		    }

		    if (mod !== 0) {
		      var pow = 1;
		      word = parseBase(number, i, number.length, base);

		      for (i = 0; i < mod; i++) {
		        pow *= base;
		      }

		      this.imuln(pow);
		      if (this.words[0] + word < 0x4000000) {
		        this.words[0] += word;
		      } else {
		        this._iaddn(word);
		      }
		    }

		    this._strip();
		  };

		  BN.prototype.copy = function copy (dest) {
		    dest.words = new Array(this.length);
		    for (var i = 0; i < this.length; i++) {
		      dest.words[i] = this.words[i];
		    }
		    dest.length = this.length;
		    dest.negative = this.negative;
		    dest.red = this.red;
		  };

		  function move (dest, src) {
		    dest.words = src.words;
		    dest.length = src.length;
		    dest.negative = src.negative;
		    dest.red = src.red;
		  }

		  BN.prototype._move = function _move (dest) {
		    move(dest, this);
		  };

		  BN.prototype.clone = function clone () {
		    var r = new BN(null);
		    this.copy(r);
		    return r;
		  };

		  BN.prototype._expand = function _expand (size) {
		    while (this.length < size) {
		      this.words[this.length++] = 0;
		    }
		    return this;
		  };

		  // Remove leading `0` from `this`
		  BN.prototype._strip = function strip () {
		    while (this.length > 1 && this.words[this.length - 1] === 0) {
		      this.length--;
		    }
		    return this._normSign();
		  };

		  BN.prototype._normSign = function _normSign () {
		    // -0 = 0
		    if (this.length === 1 && this.words[0] === 0) {
		      this.negative = 0;
		    }
		    return this;
		  };

		  // Check Symbol.for because not everywhere where Symbol defined
		  // See https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol#Browser_compatibility
		  if (typeof Symbol !== 'undefined' && typeof Symbol.for === 'function') {
		    try {
		      BN.prototype[Symbol.for('nodejs.util.inspect.custom')] = inspect;
		    } catch (e) {
		      BN.prototype.inspect = inspect;
		    }
		  } else {
		    BN.prototype.inspect = inspect;
		  }

		  function inspect () {
		    return (this.red ? '<BN-R: ' : '<BN: ') + this.toString(16) + '>';
		  }

		  /*

		  var zeros = [];
		  var groupSizes = [];
		  var groupBases = [];

		  var s = '';
		  var i = -1;
		  while (++i < BN.wordSize) {
		    zeros[i] = s;
		    s += '0';
		  }
		  groupSizes[0] = 0;
		  groupSizes[1] = 0;
		  groupBases[0] = 0;
		  groupBases[1] = 0;
		  var base = 2 - 1;
		  while (++base < 36 + 1) {
		    var groupSize = 0;
		    var groupBase = 1;
		    while (groupBase < (1 << BN.wordSize) / base) {
		      groupBase *= base;
		      groupSize += 1;
		    }
		    groupSizes[base] = groupSize;
		    groupBases[base] = groupBase;
		  }

		  */

		  var zeros = [
		    '',
		    '0',
		    '00',
		    '000',
		    '0000',
		    '00000',
		    '000000',
		    '0000000',
		    '00000000',
		    '000000000',
		    '0000000000',
		    '00000000000',
		    '000000000000',
		    '0000000000000',
		    '00000000000000',
		    '000000000000000',
		    '0000000000000000',
		    '00000000000000000',
		    '000000000000000000',
		    '0000000000000000000',
		    '00000000000000000000',
		    '000000000000000000000',
		    '0000000000000000000000',
		    '00000000000000000000000',
		    '000000000000000000000000',
		    '0000000000000000000000000'
		  ];

		  var groupSizes = [
		    0, 0,
		    25, 16, 12, 11, 10, 9, 8,
		    8, 7, 7, 7, 7, 6, 6,
		    6, 6, 6, 6, 6, 5, 5,
		    5, 5, 5, 5, 5, 5, 5,
		    5, 5, 5, 5, 5, 5, 5
		  ];

		  var groupBases = [
		    0, 0,
		    33554432, 43046721, 16777216, 48828125, 60466176, 40353607, 16777216,
		    43046721, 10000000, 19487171, 35831808, 62748517, 7529536, 11390625,
		    16777216, 24137569, 34012224, 47045881, 64000000, 4084101, 5153632,
		    6436343, 7962624, 9765625, 11881376, 14348907, 17210368, 20511149,
		    24300000, 28629151, 33554432, 39135393, 45435424, 52521875, 60466176
		  ];

		  BN.prototype.toString = function toString (base, padding) {
		    base = base || 10;
		    padding = padding | 0 || 1;

		    var out;
		    if (base === 16 || base === 'hex') {
		      out = '';
		      var off = 0;
		      var carry = 0;
		      for (var i = 0; i < this.length; i++) {
		        var w = this.words[i];
		        var word = (((w << off) | carry) & 0xffffff).toString(16);
		        carry = (w >>> (24 - off)) & 0xffffff;
		        off += 2;
		        if (off >= 26) {
		          off -= 26;
		          i--;
		        }
		        if (carry !== 0 || i !== this.length - 1) {
		          out = zeros[6 - word.length] + word + out;
		        } else {
		          out = word + out;
		        }
		      }
		      if (carry !== 0) {
		        out = carry.toString(16) + out;
		      }
		      while (out.length % padding !== 0) {
		        out = '0' + out;
		      }
		      if (this.negative !== 0) {
		        out = '-' + out;
		      }
		      return out;
		    }

		    if (base === (base | 0) && base >= 2 && base <= 36) {
		      // var groupSize = Math.floor(BN.wordSize * Math.LN2 / Math.log(base));
		      var groupSize = groupSizes[base];
		      // var groupBase = Math.pow(base, groupSize);
		      var groupBase = groupBases[base];
		      out = '';
		      var c = this.clone();
		      c.negative = 0;
		      while (!c.isZero()) {
		        var r = c.modrn(groupBase).toString(base);
		        c = c.idivn(groupBase);

		        if (!c.isZero()) {
		          out = zeros[groupSize - r.length] + r + out;
		        } else {
		          out = r + out;
		        }
		      }
		      if (this.isZero()) {
		        out = '0' + out;
		      }
		      while (out.length % padding !== 0) {
		        out = '0' + out;
		      }
		      if (this.negative !== 0) {
		        out = '-' + out;
		      }
		      return out;
		    }

		    assert(false, 'Base should be between 2 and 36');
		  };

		  BN.prototype.toNumber = function toNumber () {
		    var ret = this.words[0];
		    if (this.length === 2) {
		      ret += this.words[1] * 0x4000000;
		    } else if (this.length === 3 && this.words[2] === 0x01) {
		      // NOTE: at this stage it is known that the top bit is set
		      ret += 0x10000000000000 + (this.words[1] * 0x4000000);
		    } else if (this.length > 2) {
		      assert(false, 'Number can only safely store up to 53 bits');
		    }
		    return (this.negative !== 0) ? -ret : ret;
		  };

		  BN.prototype.toJSON = function toJSON () {
		    return this.toString(16, 2);
		  };

		  if (Buffer) {
		    BN.prototype.toBuffer = function toBuffer (endian, length) {
		      return this.toArrayLike(Buffer, endian, length);
		    };
		  }

		  BN.prototype.toArray = function toArray (endian, length) {
		    return this.toArrayLike(Array, endian, length);
		  };

		  var allocate = function allocate (ArrayType, size) {
		    if (ArrayType.allocUnsafe) {
		      return ArrayType.allocUnsafe(size);
		    }
		    return new ArrayType(size);
		  };

		  BN.prototype.toArrayLike = function toArrayLike (ArrayType, endian, length) {
		    this._strip();

		    var byteLength = this.byteLength();
		    var reqLength = length || Math.max(1, byteLength);
		    assert(byteLength <= reqLength, 'byte array longer than desired length');
		    assert(reqLength > 0, 'Requested array length <= 0');

		    var res = allocate(ArrayType, reqLength);
		    var postfix = endian === 'le' ? 'LE' : 'BE';
		    this['_toArrayLike' + postfix](res, byteLength);
		    return res;
		  };

		  BN.prototype._toArrayLikeLE = function _toArrayLikeLE (res, byteLength) {
		    var position = 0;
		    var carry = 0;

		    for (var i = 0, shift = 0; i < this.length; i++) {
		      var word = (this.words[i] << shift) | carry;

		      res[position++] = word & 0xff;
		      if (position < res.length) {
		        res[position++] = (word >> 8) & 0xff;
		      }
		      if (position < res.length) {
		        res[position++] = (word >> 16) & 0xff;
		      }

		      if (shift === 6) {
		        if (position < res.length) {
		          res[position++] = (word >> 24) & 0xff;
		        }
		        carry = 0;
		        shift = 0;
		      } else {
		        carry = word >>> 24;
		        shift += 2;
		      }
		    }

		    if (position < res.length) {
		      res[position++] = carry;

		      while (position < res.length) {
		        res[position++] = 0;
		      }
		    }
		  };

		  BN.prototype._toArrayLikeBE = function _toArrayLikeBE (res, byteLength) {
		    var position = res.length - 1;
		    var carry = 0;

		    for (var i = 0, shift = 0; i < this.length; i++) {
		      var word = (this.words[i] << shift) | carry;

		      res[position--] = word & 0xff;
		      if (position >= 0) {
		        res[position--] = (word >> 8) & 0xff;
		      }
		      if (position >= 0) {
		        res[position--] = (word >> 16) & 0xff;
		      }

		      if (shift === 6) {
		        if (position >= 0) {
		          res[position--] = (word >> 24) & 0xff;
		        }
		        carry = 0;
		        shift = 0;
		      } else {
		        carry = word >>> 24;
		        shift += 2;
		      }
		    }

		    if (position >= 0) {
		      res[position--] = carry;

		      while (position >= 0) {
		        res[position--] = 0;
		      }
		    }
		  };

		  if (Math.clz32) {
		    BN.prototype._countBits = function _countBits (w) {
		      return 32 - Math.clz32(w);
		    };
		  } else {
		    BN.prototype._countBits = function _countBits (w) {
		      var t = w;
		      var r = 0;
		      if (t >= 0x1000) {
		        r += 13;
		        t >>>= 13;
		      }
		      if (t >= 0x40) {
		        r += 7;
		        t >>>= 7;
		      }
		      if (t >= 0x8) {
		        r += 4;
		        t >>>= 4;
		      }
		      if (t >= 0x02) {
		        r += 2;
		        t >>>= 2;
		      }
		      return r + t;
		    };
		  }

		  BN.prototype._zeroBits = function _zeroBits (w) {
		    // Short-cut
		    if (w === 0) return 26;

		    var t = w;
		    var r = 0;
		    if ((t & 0x1fff) === 0) {
		      r += 13;
		      t >>>= 13;
		    }
		    if ((t & 0x7f) === 0) {
		      r += 7;
		      t >>>= 7;
		    }
		    if ((t & 0xf) === 0) {
		      r += 4;
		      t >>>= 4;
		    }
		    if ((t & 0x3) === 0) {
		      r += 2;
		      t >>>= 2;
		    }
		    if ((t & 0x1) === 0) {
		      r++;
		    }
		    return r;
		  };

		  // Return number of used bits in a BN
		  BN.prototype.bitLength = function bitLength () {
		    var w = this.words[this.length - 1];
		    var hi = this._countBits(w);
		    return (this.length - 1) * 26 + hi;
		  };

		  function toBitArray (num) {
		    var w = new Array(num.bitLength());

		    for (var bit = 0; bit < w.length; bit++) {
		      var off = (bit / 26) | 0;
		      var wbit = bit % 26;

		      w[bit] = (num.words[off] >>> wbit) & 0x01;
		    }

		    return w;
		  }

		  // Number of trailing zero bits
		  BN.prototype.zeroBits = function zeroBits () {
		    if (this.isZero()) return 0;

		    var r = 0;
		    for (var i = 0; i < this.length; i++) {
		      var b = this._zeroBits(this.words[i]);
		      r += b;
		      if (b !== 26) break;
		    }
		    return r;
		  };

		  BN.prototype.byteLength = function byteLength () {
		    return Math.ceil(this.bitLength() / 8);
		  };

		  BN.prototype.toTwos = function toTwos (width) {
		    if (this.negative !== 0) {
		      return this.abs().inotn(width).iaddn(1);
		    }
		    return this.clone();
		  };

		  BN.prototype.fromTwos = function fromTwos (width) {
		    if (this.testn(width - 1)) {
		      return this.notn(width).iaddn(1).ineg();
		    }
		    return this.clone();
		  };

		  BN.prototype.isNeg = function isNeg () {
		    return this.negative !== 0;
		  };

		  // Return negative clone of `this`
		  BN.prototype.neg = function neg () {
		    return this.clone().ineg();
		  };

		  BN.prototype.ineg = function ineg () {
		    if (!this.isZero()) {
		      this.negative ^= 1;
		    }

		    return this;
		  };

		  // Or `num` with `this` in-place
		  BN.prototype.iuor = function iuor (num) {
		    while (this.length < num.length) {
		      this.words[this.length++] = 0;
		    }

		    for (var i = 0; i < num.length; i++) {
		      this.words[i] = this.words[i] | num.words[i];
		    }

		    return this._strip();
		  };

		  BN.prototype.ior = function ior (num) {
		    assert((this.negative | num.negative) === 0);
		    return this.iuor(num);
		  };

		  // Or `num` with `this`
		  BN.prototype.or = function or (num) {
		    if (this.length > num.length) return this.clone().ior(num);
		    return num.clone().ior(this);
		  };

		  BN.prototype.uor = function uor (num) {
		    if (this.length > num.length) return this.clone().iuor(num);
		    return num.clone().iuor(this);
		  };

		  // And `num` with `this` in-place
		  BN.prototype.iuand = function iuand (num) {
		    // b = min-length(num, this)
		    var b;
		    if (this.length > num.length) {
		      b = num;
		    } else {
		      b = this;
		    }

		    for (var i = 0; i < b.length; i++) {
		      this.words[i] = this.words[i] & num.words[i];
		    }

		    this.length = b.length;

		    return this._strip();
		  };

		  BN.prototype.iand = function iand (num) {
		    assert((this.negative | num.negative) === 0);
		    return this.iuand(num);
		  };

		  // And `num` with `this`
		  BN.prototype.and = function and (num) {
		    if (this.length > num.length) return this.clone().iand(num);
		    return num.clone().iand(this);
		  };

		  BN.prototype.uand = function uand (num) {
		    if (this.length > num.length) return this.clone().iuand(num);
		    return num.clone().iuand(this);
		  };

		  // Xor `num` with `this` in-place
		  BN.prototype.iuxor = function iuxor (num) {
		    // a.length > b.length
		    var a;
		    var b;
		    if (this.length > num.length) {
		      a = this;
		      b = num;
		    } else {
		      a = num;
		      b = this;
		    }

		    for (var i = 0; i < b.length; i++) {
		      this.words[i] = a.words[i] ^ b.words[i];
		    }

		    if (this !== a) {
		      for (; i < a.length; i++) {
		        this.words[i] = a.words[i];
		      }
		    }

		    this.length = a.length;

		    return this._strip();
		  };

		  BN.prototype.ixor = function ixor (num) {
		    assert((this.negative | num.negative) === 0);
		    return this.iuxor(num);
		  };

		  // Xor `num` with `this`
		  BN.prototype.xor = function xor (num) {
		    if (this.length > num.length) return this.clone().ixor(num);
		    return num.clone().ixor(this);
		  };

		  BN.prototype.uxor = function uxor (num) {
		    if (this.length > num.length) return this.clone().iuxor(num);
		    return num.clone().iuxor(this);
		  };

		  // Not ``this`` with ``width`` bitwidth
		  BN.prototype.inotn = function inotn (width) {
		    assert(typeof width === 'number' && width >= 0);

		    var bytesNeeded = Math.ceil(width / 26) | 0;
		    var bitsLeft = width % 26;

		    // Extend the buffer with leading zeroes
		    this._expand(bytesNeeded);

		    if (bitsLeft > 0) {
		      bytesNeeded--;
		    }

		    // Handle complete words
		    for (var i = 0; i < bytesNeeded; i++) {
		      this.words[i] = ~this.words[i] & 0x3ffffff;
		    }

		    // Handle the residue
		    if (bitsLeft > 0) {
		      this.words[i] = ~this.words[i] & (0x3ffffff >> (26 - bitsLeft));
		    }

		    // And remove leading zeroes
		    return this._strip();
		  };

		  BN.prototype.notn = function notn (width) {
		    return this.clone().inotn(width);
		  };

		  // Set `bit` of `this`
		  BN.prototype.setn = function setn (bit, val) {
		    assert(typeof bit === 'number' && bit >= 0);

		    var off = (bit / 26) | 0;
		    var wbit = bit % 26;

		    this._expand(off + 1);

		    if (val) {
		      this.words[off] = this.words[off] | (1 << wbit);
		    } else {
		      this.words[off] = this.words[off] & ~(1 << wbit);
		    }

		    return this._strip();
		  };

		  // Add `num` to `this` in-place
		  BN.prototype.iadd = function iadd (num) {
		    var r;

		    // negative + positive
		    if (this.negative !== 0 && num.negative === 0) {
		      this.negative = 0;
		      r = this.isub(num);
		      this.negative ^= 1;
		      return this._normSign();

		    // positive + negative
		    } else if (this.negative === 0 && num.negative !== 0) {
		      num.negative = 0;
		      r = this.isub(num);
		      num.negative = 1;
		      return r._normSign();
		    }

		    // a.length > b.length
		    var a, b;
		    if (this.length > num.length) {
		      a = this;
		      b = num;
		    } else {
		      a = num;
		      b = this;
		    }

		    var carry = 0;
		    for (var i = 0; i < b.length; i++) {
		      r = (a.words[i] | 0) + (b.words[i] | 0) + carry;
		      this.words[i] = r & 0x3ffffff;
		      carry = r >>> 26;
		    }
		    for (; carry !== 0 && i < a.length; i++) {
		      r = (a.words[i] | 0) + carry;
		      this.words[i] = r & 0x3ffffff;
		      carry = r >>> 26;
		    }

		    this.length = a.length;
		    if (carry !== 0) {
		      this.words[this.length] = carry;
		      this.length++;
		    // Copy the rest of the words
		    } else if (a !== this) {
		      for (; i < a.length; i++) {
		        this.words[i] = a.words[i];
		      }
		    }

		    return this;
		  };

		  // Add `num` to `this`
		  BN.prototype.add = function add (num) {
		    var res;
		    if (num.negative !== 0 && this.negative === 0) {
		      num.negative = 0;
		      res = this.sub(num);
		      num.negative ^= 1;
		      return res;
		    } else if (num.negative === 0 && this.negative !== 0) {
		      this.negative = 0;
		      res = num.sub(this);
		      this.negative = 1;
		      return res;
		    }

		    if (this.length > num.length) return this.clone().iadd(num);

		    return num.clone().iadd(this);
		  };

		  // Subtract `num` from `this` in-place
		  BN.prototype.isub = function isub (num) {
		    // this - (-num) = this + num
		    if (num.negative !== 0) {
		      num.negative = 0;
		      var r = this.iadd(num);
		      num.negative = 1;
		      return r._normSign();

		    // -this - num = -(this + num)
		    } else if (this.negative !== 0) {
		      this.negative = 0;
		      this.iadd(num);
		      this.negative = 1;
		      return this._normSign();
		    }

		    // At this point both numbers are positive
		    var cmp = this.cmp(num);

		    // Optimization - zeroify
		    if (cmp === 0) {
		      this.negative = 0;
		      this.length = 1;
		      this.words[0] = 0;
		      return this;
		    }

		    // a > b
		    var a, b;
		    if (cmp > 0) {
		      a = this;
		      b = num;
		    } else {
		      a = num;
		      b = this;
		    }

		    var carry = 0;
		    for (var i = 0; i < b.length; i++) {
		      r = (a.words[i] | 0) - (b.words[i] | 0) + carry;
		      carry = r >> 26;
		      this.words[i] = r & 0x3ffffff;
		    }
		    for (; carry !== 0 && i < a.length; i++) {
		      r = (a.words[i] | 0) + carry;
		      carry = r >> 26;
		      this.words[i] = r & 0x3ffffff;
		    }

		    // Copy rest of the words
		    if (carry === 0 && i < a.length && a !== this) {
		      for (; i < a.length; i++) {
		        this.words[i] = a.words[i];
		      }
		    }

		    this.length = Math.max(this.length, i);

		    if (a !== this) {
		      this.negative = 1;
		    }

		    return this._strip();
		  };

		  // Subtract `num` from `this`
		  BN.prototype.sub = function sub (num) {
		    return this.clone().isub(num);
		  };

		  function smallMulTo (self, num, out) {
		    out.negative = num.negative ^ self.negative;
		    var len = (self.length + num.length) | 0;
		    out.length = len;
		    len = (len - 1) | 0;

		    // Peel one iteration (compiler can't do it, because of code complexity)
		    var a = self.words[0] | 0;
		    var b = num.words[0] | 0;
		    var r = a * b;

		    var lo = r & 0x3ffffff;
		    var carry = (r / 0x4000000) | 0;
		    out.words[0] = lo;

		    for (var k = 1; k < len; k++) {
		      // Sum all words with the same `i + j = k` and accumulate `ncarry`,
		      // note that ncarry could be >= 0x3ffffff
		      var ncarry = carry >>> 26;
		      var rword = carry & 0x3ffffff;
		      var maxJ = Math.min(k, num.length - 1);
		      for (var j = Math.max(0, k - self.length + 1); j <= maxJ; j++) {
		        var i = (k - j) | 0;
		        a = self.words[i] | 0;
		        b = num.words[j] | 0;
		        r = a * b + rword;
		        ncarry += (r / 0x4000000) | 0;
		        rword = r & 0x3ffffff;
		      }
		      out.words[k] = rword | 0;
		      carry = ncarry | 0;
		    }
		    if (carry !== 0) {
		      out.words[k] = carry | 0;
		    } else {
		      out.length--;
		    }

		    return out._strip();
		  }

		  // TODO(indutny): it may be reasonable to omit it for users who don't need
		  // to work with 256-bit numbers, otherwise it gives 20% improvement for 256-bit
		  // multiplication (like elliptic secp256k1).
		  var comb10MulTo = function comb10MulTo (self, num, out) {
		    var a = self.words;
		    var b = num.words;
		    var o = out.words;
		    var c = 0;
		    var lo;
		    var mid;
		    var hi;
		    var a0 = a[0] | 0;
		    var al0 = a0 & 0x1fff;
		    var ah0 = a0 >>> 13;
		    var a1 = a[1] | 0;
		    var al1 = a1 & 0x1fff;
		    var ah1 = a1 >>> 13;
		    var a2 = a[2] | 0;
		    var al2 = a2 & 0x1fff;
		    var ah2 = a2 >>> 13;
		    var a3 = a[3] | 0;
		    var al3 = a3 & 0x1fff;
		    var ah3 = a3 >>> 13;
		    var a4 = a[4] | 0;
		    var al4 = a4 & 0x1fff;
		    var ah4 = a4 >>> 13;
		    var a5 = a[5] | 0;
		    var al5 = a5 & 0x1fff;
		    var ah5 = a5 >>> 13;
		    var a6 = a[6] | 0;
		    var al6 = a6 & 0x1fff;
		    var ah6 = a6 >>> 13;
		    var a7 = a[7] | 0;
		    var al7 = a7 & 0x1fff;
		    var ah7 = a7 >>> 13;
		    var a8 = a[8] | 0;
		    var al8 = a8 & 0x1fff;
		    var ah8 = a8 >>> 13;
		    var a9 = a[9] | 0;
		    var al9 = a9 & 0x1fff;
		    var ah9 = a9 >>> 13;
		    var b0 = b[0] | 0;
		    var bl0 = b0 & 0x1fff;
		    var bh0 = b0 >>> 13;
		    var b1 = b[1] | 0;
		    var bl1 = b1 & 0x1fff;
		    var bh1 = b1 >>> 13;
		    var b2 = b[2] | 0;
		    var bl2 = b2 & 0x1fff;
		    var bh2 = b2 >>> 13;
		    var b3 = b[3] | 0;
		    var bl3 = b3 & 0x1fff;
		    var bh3 = b3 >>> 13;
		    var b4 = b[4] | 0;
		    var bl4 = b4 & 0x1fff;
		    var bh4 = b4 >>> 13;
		    var b5 = b[5] | 0;
		    var bl5 = b5 & 0x1fff;
		    var bh5 = b5 >>> 13;
		    var b6 = b[6] | 0;
		    var bl6 = b6 & 0x1fff;
		    var bh6 = b6 >>> 13;
		    var b7 = b[7] | 0;
		    var bl7 = b7 & 0x1fff;
		    var bh7 = b7 >>> 13;
		    var b8 = b[8] | 0;
		    var bl8 = b8 & 0x1fff;
		    var bh8 = b8 >>> 13;
		    var b9 = b[9] | 0;
		    var bl9 = b9 & 0x1fff;
		    var bh9 = b9 >>> 13;

		    out.negative = self.negative ^ num.negative;
		    out.length = 19;
		    /* k = 0 */
		    lo = Math.imul(al0, bl0);
		    mid = Math.imul(al0, bh0);
		    mid = (mid + Math.imul(ah0, bl0)) | 0;
		    hi = Math.imul(ah0, bh0);
		    var w0 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w0 >>> 26)) | 0;
		    w0 &= 0x3ffffff;
		    /* k = 1 */
		    lo = Math.imul(al1, bl0);
		    mid = Math.imul(al1, bh0);
		    mid = (mid + Math.imul(ah1, bl0)) | 0;
		    hi = Math.imul(ah1, bh0);
		    lo = (lo + Math.imul(al0, bl1)) | 0;
		    mid = (mid + Math.imul(al0, bh1)) | 0;
		    mid = (mid + Math.imul(ah0, bl1)) | 0;
		    hi = (hi + Math.imul(ah0, bh1)) | 0;
		    var w1 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w1 >>> 26)) | 0;
		    w1 &= 0x3ffffff;
		    /* k = 2 */
		    lo = Math.imul(al2, bl0);
		    mid = Math.imul(al2, bh0);
		    mid = (mid + Math.imul(ah2, bl0)) | 0;
		    hi = Math.imul(ah2, bh0);
		    lo = (lo + Math.imul(al1, bl1)) | 0;
		    mid = (mid + Math.imul(al1, bh1)) | 0;
		    mid = (mid + Math.imul(ah1, bl1)) | 0;
		    hi = (hi + Math.imul(ah1, bh1)) | 0;
		    lo = (lo + Math.imul(al0, bl2)) | 0;
		    mid = (mid + Math.imul(al0, bh2)) | 0;
		    mid = (mid + Math.imul(ah0, bl2)) | 0;
		    hi = (hi + Math.imul(ah0, bh2)) | 0;
		    var w2 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w2 >>> 26)) | 0;
		    w2 &= 0x3ffffff;
		    /* k = 3 */
		    lo = Math.imul(al3, bl0);
		    mid = Math.imul(al3, bh0);
		    mid = (mid + Math.imul(ah3, bl0)) | 0;
		    hi = Math.imul(ah3, bh0);
		    lo = (lo + Math.imul(al2, bl1)) | 0;
		    mid = (mid + Math.imul(al2, bh1)) | 0;
		    mid = (mid + Math.imul(ah2, bl1)) | 0;
		    hi = (hi + Math.imul(ah2, bh1)) | 0;
		    lo = (lo + Math.imul(al1, bl2)) | 0;
		    mid = (mid + Math.imul(al1, bh2)) | 0;
		    mid = (mid + Math.imul(ah1, bl2)) | 0;
		    hi = (hi + Math.imul(ah1, bh2)) | 0;
		    lo = (lo + Math.imul(al0, bl3)) | 0;
		    mid = (mid + Math.imul(al0, bh3)) | 0;
		    mid = (mid + Math.imul(ah0, bl3)) | 0;
		    hi = (hi + Math.imul(ah0, bh3)) | 0;
		    var w3 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w3 >>> 26)) | 0;
		    w3 &= 0x3ffffff;
		    /* k = 4 */
		    lo = Math.imul(al4, bl0);
		    mid = Math.imul(al4, bh0);
		    mid = (mid + Math.imul(ah4, bl0)) | 0;
		    hi = Math.imul(ah4, bh0);
		    lo = (lo + Math.imul(al3, bl1)) | 0;
		    mid = (mid + Math.imul(al3, bh1)) | 0;
		    mid = (mid + Math.imul(ah3, bl1)) | 0;
		    hi = (hi + Math.imul(ah3, bh1)) | 0;
		    lo = (lo + Math.imul(al2, bl2)) | 0;
		    mid = (mid + Math.imul(al2, bh2)) | 0;
		    mid = (mid + Math.imul(ah2, bl2)) | 0;
		    hi = (hi + Math.imul(ah2, bh2)) | 0;
		    lo = (lo + Math.imul(al1, bl3)) | 0;
		    mid = (mid + Math.imul(al1, bh3)) | 0;
		    mid = (mid + Math.imul(ah1, bl3)) | 0;
		    hi = (hi + Math.imul(ah1, bh3)) | 0;
		    lo = (lo + Math.imul(al0, bl4)) | 0;
		    mid = (mid + Math.imul(al0, bh4)) | 0;
		    mid = (mid + Math.imul(ah0, bl4)) | 0;
		    hi = (hi + Math.imul(ah0, bh4)) | 0;
		    var w4 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w4 >>> 26)) | 0;
		    w4 &= 0x3ffffff;
		    /* k = 5 */
		    lo = Math.imul(al5, bl0);
		    mid = Math.imul(al5, bh0);
		    mid = (mid + Math.imul(ah5, bl0)) | 0;
		    hi = Math.imul(ah5, bh0);
		    lo = (lo + Math.imul(al4, bl1)) | 0;
		    mid = (mid + Math.imul(al4, bh1)) | 0;
		    mid = (mid + Math.imul(ah4, bl1)) | 0;
		    hi = (hi + Math.imul(ah4, bh1)) | 0;
		    lo = (lo + Math.imul(al3, bl2)) | 0;
		    mid = (mid + Math.imul(al3, bh2)) | 0;
		    mid = (mid + Math.imul(ah3, bl2)) | 0;
		    hi = (hi + Math.imul(ah3, bh2)) | 0;
		    lo = (lo + Math.imul(al2, bl3)) | 0;
		    mid = (mid + Math.imul(al2, bh3)) | 0;
		    mid = (mid + Math.imul(ah2, bl3)) | 0;
		    hi = (hi + Math.imul(ah2, bh3)) | 0;
		    lo = (lo + Math.imul(al1, bl4)) | 0;
		    mid = (mid + Math.imul(al1, bh4)) | 0;
		    mid = (mid + Math.imul(ah1, bl4)) | 0;
		    hi = (hi + Math.imul(ah1, bh4)) | 0;
		    lo = (lo + Math.imul(al0, bl5)) | 0;
		    mid = (mid + Math.imul(al0, bh5)) | 0;
		    mid = (mid + Math.imul(ah0, bl5)) | 0;
		    hi = (hi + Math.imul(ah0, bh5)) | 0;
		    var w5 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w5 >>> 26)) | 0;
		    w5 &= 0x3ffffff;
		    /* k = 6 */
		    lo = Math.imul(al6, bl0);
		    mid = Math.imul(al6, bh0);
		    mid = (mid + Math.imul(ah6, bl0)) | 0;
		    hi = Math.imul(ah6, bh0);
		    lo = (lo + Math.imul(al5, bl1)) | 0;
		    mid = (mid + Math.imul(al5, bh1)) | 0;
		    mid = (mid + Math.imul(ah5, bl1)) | 0;
		    hi = (hi + Math.imul(ah5, bh1)) | 0;
		    lo = (lo + Math.imul(al4, bl2)) | 0;
		    mid = (mid + Math.imul(al4, bh2)) | 0;
		    mid = (mid + Math.imul(ah4, bl2)) | 0;
		    hi = (hi + Math.imul(ah4, bh2)) | 0;
		    lo = (lo + Math.imul(al3, bl3)) | 0;
		    mid = (mid + Math.imul(al3, bh3)) | 0;
		    mid = (mid + Math.imul(ah3, bl3)) | 0;
		    hi = (hi + Math.imul(ah3, bh3)) | 0;
		    lo = (lo + Math.imul(al2, bl4)) | 0;
		    mid = (mid + Math.imul(al2, bh4)) | 0;
		    mid = (mid + Math.imul(ah2, bl4)) | 0;
		    hi = (hi + Math.imul(ah2, bh4)) | 0;
		    lo = (lo + Math.imul(al1, bl5)) | 0;
		    mid = (mid + Math.imul(al1, bh5)) | 0;
		    mid = (mid + Math.imul(ah1, bl5)) | 0;
		    hi = (hi + Math.imul(ah1, bh5)) | 0;
		    lo = (lo + Math.imul(al0, bl6)) | 0;
		    mid = (mid + Math.imul(al0, bh6)) | 0;
		    mid = (mid + Math.imul(ah0, bl6)) | 0;
		    hi = (hi + Math.imul(ah0, bh6)) | 0;
		    var w6 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w6 >>> 26)) | 0;
		    w6 &= 0x3ffffff;
		    /* k = 7 */
		    lo = Math.imul(al7, bl0);
		    mid = Math.imul(al7, bh0);
		    mid = (mid + Math.imul(ah7, bl0)) | 0;
		    hi = Math.imul(ah7, bh0);
		    lo = (lo + Math.imul(al6, bl1)) | 0;
		    mid = (mid + Math.imul(al6, bh1)) | 0;
		    mid = (mid + Math.imul(ah6, bl1)) | 0;
		    hi = (hi + Math.imul(ah6, bh1)) | 0;
		    lo = (lo + Math.imul(al5, bl2)) | 0;
		    mid = (mid + Math.imul(al5, bh2)) | 0;
		    mid = (mid + Math.imul(ah5, bl2)) | 0;
		    hi = (hi + Math.imul(ah5, bh2)) | 0;
		    lo = (lo + Math.imul(al4, bl3)) | 0;
		    mid = (mid + Math.imul(al4, bh3)) | 0;
		    mid = (mid + Math.imul(ah4, bl3)) | 0;
		    hi = (hi + Math.imul(ah4, bh3)) | 0;
		    lo = (lo + Math.imul(al3, bl4)) | 0;
		    mid = (mid + Math.imul(al3, bh4)) | 0;
		    mid = (mid + Math.imul(ah3, bl4)) | 0;
		    hi = (hi + Math.imul(ah3, bh4)) | 0;
		    lo = (lo + Math.imul(al2, bl5)) | 0;
		    mid = (mid + Math.imul(al2, bh5)) | 0;
		    mid = (mid + Math.imul(ah2, bl5)) | 0;
		    hi = (hi + Math.imul(ah2, bh5)) | 0;
		    lo = (lo + Math.imul(al1, bl6)) | 0;
		    mid = (mid + Math.imul(al1, bh6)) | 0;
		    mid = (mid + Math.imul(ah1, bl6)) | 0;
		    hi = (hi + Math.imul(ah1, bh6)) | 0;
		    lo = (lo + Math.imul(al0, bl7)) | 0;
		    mid = (mid + Math.imul(al0, bh7)) | 0;
		    mid = (mid + Math.imul(ah0, bl7)) | 0;
		    hi = (hi + Math.imul(ah0, bh7)) | 0;
		    var w7 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w7 >>> 26)) | 0;
		    w7 &= 0x3ffffff;
		    /* k = 8 */
		    lo = Math.imul(al8, bl0);
		    mid = Math.imul(al8, bh0);
		    mid = (mid + Math.imul(ah8, bl0)) | 0;
		    hi = Math.imul(ah8, bh0);
		    lo = (lo + Math.imul(al7, bl1)) | 0;
		    mid = (mid + Math.imul(al7, bh1)) | 0;
		    mid = (mid + Math.imul(ah7, bl1)) | 0;
		    hi = (hi + Math.imul(ah7, bh1)) | 0;
		    lo = (lo + Math.imul(al6, bl2)) | 0;
		    mid = (mid + Math.imul(al6, bh2)) | 0;
		    mid = (mid + Math.imul(ah6, bl2)) | 0;
		    hi = (hi + Math.imul(ah6, bh2)) | 0;
		    lo = (lo + Math.imul(al5, bl3)) | 0;
		    mid = (mid + Math.imul(al5, bh3)) | 0;
		    mid = (mid + Math.imul(ah5, bl3)) | 0;
		    hi = (hi + Math.imul(ah5, bh3)) | 0;
		    lo = (lo + Math.imul(al4, bl4)) | 0;
		    mid = (mid + Math.imul(al4, bh4)) | 0;
		    mid = (mid + Math.imul(ah4, bl4)) | 0;
		    hi = (hi + Math.imul(ah4, bh4)) | 0;
		    lo = (lo + Math.imul(al3, bl5)) | 0;
		    mid = (mid + Math.imul(al3, bh5)) | 0;
		    mid = (mid + Math.imul(ah3, bl5)) | 0;
		    hi = (hi + Math.imul(ah3, bh5)) | 0;
		    lo = (lo + Math.imul(al2, bl6)) | 0;
		    mid = (mid + Math.imul(al2, bh6)) | 0;
		    mid = (mid + Math.imul(ah2, bl6)) | 0;
		    hi = (hi + Math.imul(ah2, bh6)) | 0;
		    lo = (lo + Math.imul(al1, bl7)) | 0;
		    mid = (mid + Math.imul(al1, bh7)) | 0;
		    mid = (mid + Math.imul(ah1, bl7)) | 0;
		    hi = (hi + Math.imul(ah1, bh7)) | 0;
		    lo = (lo + Math.imul(al0, bl8)) | 0;
		    mid = (mid + Math.imul(al0, bh8)) | 0;
		    mid = (mid + Math.imul(ah0, bl8)) | 0;
		    hi = (hi + Math.imul(ah0, bh8)) | 0;
		    var w8 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w8 >>> 26)) | 0;
		    w8 &= 0x3ffffff;
		    /* k = 9 */
		    lo = Math.imul(al9, bl0);
		    mid = Math.imul(al9, bh0);
		    mid = (mid + Math.imul(ah9, bl0)) | 0;
		    hi = Math.imul(ah9, bh0);
		    lo = (lo + Math.imul(al8, bl1)) | 0;
		    mid = (mid + Math.imul(al8, bh1)) | 0;
		    mid = (mid + Math.imul(ah8, bl1)) | 0;
		    hi = (hi + Math.imul(ah8, bh1)) | 0;
		    lo = (lo + Math.imul(al7, bl2)) | 0;
		    mid = (mid + Math.imul(al7, bh2)) | 0;
		    mid = (mid + Math.imul(ah7, bl2)) | 0;
		    hi = (hi + Math.imul(ah7, bh2)) | 0;
		    lo = (lo + Math.imul(al6, bl3)) | 0;
		    mid = (mid + Math.imul(al6, bh3)) | 0;
		    mid = (mid + Math.imul(ah6, bl3)) | 0;
		    hi = (hi + Math.imul(ah6, bh3)) | 0;
		    lo = (lo + Math.imul(al5, bl4)) | 0;
		    mid = (mid + Math.imul(al5, bh4)) | 0;
		    mid = (mid + Math.imul(ah5, bl4)) | 0;
		    hi = (hi + Math.imul(ah5, bh4)) | 0;
		    lo = (lo + Math.imul(al4, bl5)) | 0;
		    mid = (mid + Math.imul(al4, bh5)) | 0;
		    mid = (mid + Math.imul(ah4, bl5)) | 0;
		    hi = (hi + Math.imul(ah4, bh5)) | 0;
		    lo = (lo + Math.imul(al3, bl6)) | 0;
		    mid = (mid + Math.imul(al3, bh6)) | 0;
		    mid = (mid + Math.imul(ah3, bl6)) | 0;
		    hi = (hi + Math.imul(ah3, bh6)) | 0;
		    lo = (lo + Math.imul(al2, bl7)) | 0;
		    mid = (mid + Math.imul(al2, bh7)) | 0;
		    mid = (mid + Math.imul(ah2, bl7)) | 0;
		    hi = (hi + Math.imul(ah2, bh7)) | 0;
		    lo = (lo + Math.imul(al1, bl8)) | 0;
		    mid = (mid + Math.imul(al1, bh8)) | 0;
		    mid = (mid + Math.imul(ah1, bl8)) | 0;
		    hi = (hi + Math.imul(ah1, bh8)) | 0;
		    lo = (lo + Math.imul(al0, bl9)) | 0;
		    mid = (mid + Math.imul(al0, bh9)) | 0;
		    mid = (mid + Math.imul(ah0, bl9)) | 0;
		    hi = (hi + Math.imul(ah0, bh9)) | 0;
		    var w9 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w9 >>> 26)) | 0;
		    w9 &= 0x3ffffff;
		    /* k = 10 */
		    lo = Math.imul(al9, bl1);
		    mid = Math.imul(al9, bh1);
		    mid = (mid + Math.imul(ah9, bl1)) | 0;
		    hi = Math.imul(ah9, bh1);
		    lo = (lo + Math.imul(al8, bl2)) | 0;
		    mid = (mid + Math.imul(al8, bh2)) | 0;
		    mid = (mid + Math.imul(ah8, bl2)) | 0;
		    hi = (hi + Math.imul(ah8, bh2)) | 0;
		    lo = (lo + Math.imul(al7, bl3)) | 0;
		    mid = (mid + Math.imul(al7, bh3)) | 0;
		    mid = (mid + Math.imul(ah7, bl3)) | 0;
		    hi = (hi + Math.imul(ah7, bh3)) | 0;
		    lo = (lo + Math.imul(al6, bl4)) | 0;
		    mid = (mid + Math.imul(al6, bh4)) | 0;
		    mid = (mid + Math.imul(ah6, bl4)) | 0;
		    hi = (hi + Math.imul(ah6, bh4)) | 0;
		    lo = (lo + Math.imul(al5, bl5)) | 0;
		    mid = (mid + Math.imul(al5, bh5)) | 0;
		    mid = (mid + Math.imul(ah5, bl5)) | 0;
		    hi = (hi + Math.imul(ah5, bh5)) | 0;
		    lo = (lo + Math.imul(al4, bl6)) | 0;
		    mid = (mid + Math.imul(al4, bh6)) | 0;
		    mid = (mid + Math.imul(ah4, bl6)) | 0;
		    hi = (hi + Math.imul(ah4, bh6)) | 0;
		    lo = (lo + Math.imul(al3, bl7)) | 0;
		    mid = (mid + Math.imul(al3, bh7)) | 0;
		    mid = (mid + Math.imul(ah3, bl7)) | 0;
		    hi = (hi + Math.imul(ah3, bh7)) | 0;
		    lo = (lo + Math.imul(al2, bl8)) | 0;
		    mid = (mid + Math.imul(al2, bh8)) | 0;
		    mid = (mid + Math.imul(ah2, bl8)) | 0;
		    hi = (hi + Math.imul(ah2, bh8)) | 0;
		    lo = (lo + Math.imul(al1, bl9)) | 0;
		    mid = (mid + Math.imul(al1, bh9)) | 0;
		    mid = (mid + Math.imul(ah1, bl9)) | 0;
		    hi = (hi + Math.imul(ah1, bh9)) | 0;
		    var w10 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w10 >>> 26)) | 0;
		    w10 &= 0x3ffffff;
		    /* k = 11 */
		    lo = Math.imul(al9, bl2);
		    mid = Math.imul(al9, bh2);
		    mid = (mid + Math.imul(ah9, bl2)) | 0;
		    hi = Math.imul(ah9, bh2);
		    lo = (lo + Math.imul(al8, bl3)) | 0;
		    mid = (mid + Math.imul(al8, bh3)) | 0;
		    mid = (mid + Math.imul(ah8, bl3)) | 0;
		    hi = (hi + Math.imul(ah8, bh3)) | 0;
		    lo = (lo + Math.imul(al7, bl4)) | 0;
		    mid = (mid + Math.imul(al7, bh4)) | 0;
		    mid = (mid + Math.imul(ah7, bl4)) | 0;
		    hi = (hi + Math.imul(ah7, bh4)) | 0;
		    lo = (lo + Math.imul(al6, bl5)) | 0;
		    mid = (mid + Math.imul(al6, bh5)) | 0;
		    mid = (mid + Math.imul(ah6, bl5)) | 0;
		    hi = (hi + Math.imul(ah6, bh5)) | 0;
		    lo = (lo + Math.imul(al5, bl6)) | 0;
		    mid = (mid + Math.imul(al5, bh6)) | 0;
		    mid = (mid + Math.imul(ah5, bl6)) | 0;
		    hi = (hi + Math.imul(ah5, bh6)) | 0;
		    lo = (lo + Math.imul(al4, bl7)) | 0;
		    mid = (mid + Math.imul(al4, bh7)) | 0;
		    mid = (mid + Math.imul(ah4, bl7)) | 0;
		    hi = (hi + Math.imul(ah4, bh7)) | 0;
		    lo = (lo + Math.imul(al3, bl8)) | 0;
		    mid = (mid + Math.imul(al3, bh8)) | 0;
		    mid = (mid + Math.imul(ah3, bl8)) | 0;
		    hi = (hi + Math.imul(ah3, bh8)) | 0;
		    lo = (lo + Math.imul(al2, bl9)) | 0;
		    mid = (mid + Math.imul(al2, bh9)) | 0;
		    mid = (mid + Math.imul(ah2, bl9)) | 0;
		    hi = (hi + Math.imul(ah2, bh9)) | 0;
		    var w11 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w11 >>> 26)) | 0;
		    w11 &= 0x3ffffff;
		    /* k = 12 */
		    lo = Math.imul(al9, bl3);
		    mid = Math.imul(al9, bh3);
		    mid = (mid + Math.imul(ah9, bl3)) | 0;
		    hi = Math.imul(ah9, bh3);
		    lo = (lo + Math.imul(al8, bl4)) | 0;
		    mid = (mid + Math.imul(al8, bh4)) | 0;
		    mid = (mid + Math.imul(ah8, bl4)) | 0;
		    hi = (hi + Math.imul(ah8, bh4)) | 0;
		    lo = (lo + Math.imul(al7, bl5)) | 0;
		    mid = (mid + Math.imul(al7, bh5)) | 0;
		    mid = (mid + Math.imul(ah7, bl5)) | 0;
		    hi = (hi + Math.imul(ah7, bh5)) | 0;
		    lo = (lo + Math.imul(al6, bl6)) | 0;
		    mid = (mid + Math.imul(al6, bh6)) | 0;
		    mid = (mid + Math.imul(ah6, bl6)) | 0;
		    hi = (hi + Math.imul(ah6, bh6)) | 0;
		    lo = (lo + Math.imul(al5, bl7)) | 0;
		    mid = (mid + Math.imul(al5, bh7)) | 0;
		    mid = (mid + Math.imul(ah5, bl7)) | 0;
		    hi = (hi + Math.imul(ah5, bh7)) | 0;
		    lo = (lo + Math.imul(al4, bl8)) | 0;
		    mid = (mid + Math.imul(al4, bh8)) | 0;
		    mid = (mid + Math.imul(ah4, bl8)) | 0;
		    hi = (hi + Math.imul(ah4, bh8)) | 0;
		    lo = (lo + Math.imul(al3, bl9)) | 0;
		    mid = (mid + Math.imul(al3, bh9)) | 0;
		    mid = (mid + Math.imul(ah3, bl9)) | 0;
		    hi = (hi + Math.imul(ah3, bh9)) | 0;
		    var w12 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w12 >>> 26)) | 0;
		    w12 &= 0x3ffffff;
		    /* k = 13 */
		    lo = Math.imul(al9, bl4);
		    mid = Math.imul(al9, bh4);
		    mid = (mid + Math.imul(ah9, bl4)) | 0;
		    hi = Math.imul(ah9, bh4);
		    lo = (lo + Math.imul(al8, bl5)) | 0;
		    mid = (mid + Math.imul(al8, bh5)) | 0;
		    mid = (mid + Math.imul(ah8, bl5)) | 0;
		    hi = (hi + Math.imul(ah8, bh5)) | 0;
		    lo = (lo + Math.imul(al7, bl6)) | 0;
		    mid = (mid + Math.imul(al7, bh6)) | 0;
		    mid = (mid + Math.imul(ah7, bl6)) | 0;
		    hi = (hi + Math.imul(ah7, bh6)) | 0;
		    lo = (lo + Math.imul(al6, bl7)) | 0;
		    mid = (mid + Math.imul(al6, bh7)) | 0;
		    mid = (mid + Math.imul(ah6, bl7)) | 0;
		    hi = (hi + Math.imul(ah6, bh7)) | 0;
		    lo = (lo + Math.imul(al5, bl8)) | 0;
		    mid = (mid + Math.imul(al5, bh8)) | 0;
		    mid = (mid + Math.imul(ah5, bl8)) | 0;
		    hi = (hi + Math.imul(ah5, bh8)) | 0;
		    lo = (lo + Math.imul(al4, bl9)) | 0;
		    mid = (mid + Math.imul(al4, bh9)) | 0;
		    mid = (mid + Math.imul(ah4, bl9)) | 0;
		    hi = (hi + Math.imul(ah4, bh9)) | 0;
		    var w13 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w13 >>> 26)) | 0;
		    w13 &= 0x3ffffff;
		    /* k = 14 */
		    lo = Math.imul(al9, bl5);
		    mid = Math.imul(al9, bh5);
		    mid = (mid + Math.imul(ah9, bl5)) | 0;
		    hi = Math.imul(ah9, bh5);
		    lo = (lo + Math.imul(al8, bl6)) | 0;
		    mid = (mid + Math.imul(al8, bh6)) | 0;
		    mid = (mid + Math.imul(ah8, bl6)) | 0;
		    hi = (hi + Math.imul(ah8, bh6)) | 0;
		    lo = (lo + Math.imul(al7, bl7)) | 0;
		    mid = (mid + Math.imul(al7, bh7)) | 0;
		    mid = (mid + Math.imul(ah7, bl7)) | 0;
		    hi = (hi + Math.imul(ah7, bh7)) | 0;
		    lo = (lo + Math.imul(al6, bl8)) | 0;
		    mid = (mid + Math.imul(al6, bh8)) | 0;
		    mid = (mid + Math.imul(ah6, bl8)) | 0;
		    hi = (hi + Math.imul(ah6, bh8)) | 0;
		    lo = (lo + Math.imul(al5, bl9)) | 0;
		    mid = (mid + Math.imul(al5, bh9)) | 0;
		    mid = (mid + Math.imul(ah5, bl9)) | 0;
		    hi = (hi + Math.imul(ah5, bh9)) | 0;
		    var w14 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w14 >>> 26)) | 0;
		    w14 &= 0x3ffffff;
		    /* k = 15 */
		    lo = Math.imul(al9, bl6);
		    mid = Math.imul(al9, bh6);
		    mid = (mid + Math.imul(ah9, bl6)) | 0;
		    hi = Math.imul(ah9, bh6);
		    lo = (lo + Math.imul(al8, bl7)) | 0;
		    mid = (mid + Math.imul(al8, bh7)) | 0;
		    mid = (mid + Math.imul(ah8, bl7)) | 0;
		    hi = (hi + Math.imul(ah8, bh7)) | 0;
		    lo = (lo + Math.imul(al7, bl8)) | 0;
		    mid = (mid + Math.imul(al7, bh8)) | 0;
		    mid = (mid + Math.imul(ah7, bl8)) | 0;
		    hi = (hi + Math.imul(ah7, bh8)) | 0;
		    lo = (lo + Math.imul(al6, bl9)) | 0;
		    mid = (mid + Math.imul(al6, bh9)) | 0;
		    mid = (mid + Math.imul(ah6, bl9)) | 0;
		    hi = (hi + Math.imul(ah6, bh9)) | 0;
		    var w15 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w15 >>> 26)) | 0;
		    w15 &= 0x3ffffff;
		    /* k = 16 */
		    lo = Math.imul(al9, bl7);
		    mid = Math.imul(al9, bh7);
		    mid = (mid + Math.imul(ah9, bl7)) | 0;
		    hi = Math.imul(ah9, bh7);
		    lo = (lo + Math.imul(al8, bl8)) | 0;
		    mid = (mid + Math.imul(al8, bh8)) | 0;
		    mid = (mid + Math.imul(ah8, bl8)) | 0;
		    hi = (hi + Math.imul(ah8, bh8)) | 0;
		    lo = (lo + Math.imul(al7, bl9)) | 0;
		    mid = (mid + Math.imul(al7, bh9)) | 0;
		    mid = (mid + Math.imul(ah7, bl9)) | 0;
		    hi = (hi + Math.imul(ah7, bh9)) | 0;
		    var w16 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w16 >>> 26)) | 0;
		    w16 &= 0x3ffffff;
		    /* k = 17 */
		    lo = Math.imul(al9, bl8);
		    mid = Math.imul(al9, bh8);
		    mid = (mid + Math.imul(ah9, bl8)) | 0;
		    hi = Math.imul(ah9, bh8);
		    lo = (lo + Math.imul(al8, bl9)) | 0;
		    mid = (mid + Math.imul(al8, bh9)) | 0;
		    mid = (mid + Math.imul(ah8, bl9)) | 0;
		    hi = (hi + Math.imul(ah8, bh9)) | 0;
		    var w17 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w17 >>> 26)) | 0;
		    w17 &= 0x3ffffff;
		    /* k = 18 */
		    lo = Math.imul(al9, bl9);
		    mid = Math.imul(al9, bh9);
		    mid = (mid + Math.imul(ah9, bl9)) | 0;
		    hi = Math.imul(ah9, bh9);
		    var w18 = (((c + lo) | 0) + ((mid & 0x1fff) << 13)) | 0;
		    c = (((hi + (mid >>> 13)) | 0) + (w18 >>> 26)) | 0;
		    w18 &= 0x3ffffff;
		    o[0] = w0;
		    o[1] = w1;
		    o[2] = w2;
		    o[3] = w3;
		    o[4] = w4;
		    o[5] = w5;
		    o[6] = w6;
		    o[7] = w7;
		    o[8] = w8;
		    o[9] = w9;
		    o[10] = w10;
		    o[11] = w11;
		    o[12] = w12;
		    o[13] = w13;
		    o[14] = w14;
		    o[15] = w15;
		    o[16] = w16;
		    o[17] = w17;
		    o[18] = w18;
		    if (c !== 0) {
		      o[19] = c;
		      out.length++;
		    }
		    return out;
		  };

		  // Polyfill comb
		  if (!Math.imul) {
		    comb10MulTo = smallMulTo;
		  }

		  function bigMulTo (self, num, out) {
		    out.negative = num.negative ^ self.negative;
		    out.length = self.length + num.length;

		    var carry = 0;
		    var hncarry = 0;
		    for (var k = 0; k < out.length - 1; k++) {
		      // Sum all words with the same `i + j = k` and accumulate `ncarry`,
		      // note that ncarry could be >= 0x3ffffff
		      var ncarry = hncarry;
		      hncarry = 0;
		      var rword = carry & 0x3ffffff;
		      var maxJ = Math.min(k, num.length - 1);
		      for (var j = Math.max(0, k - self.length + 1); j <= maxJ; j++) {
		        var i = k - j;
		        var a = self.words[i] | 0;
		        var b = num.words[j] | 0;
		        var r = a * b;

		        var lo = r & 0x3ffffff;
		        ncarry = (ncarry + ((r / 0x4000000) | 0)) | 0;
		        lo = (lo + rword) | 0;
		        rword = lo & 0x3ffffff;
		        ncarry = (ncarry + (lo >>> 26)) | 0;

		        hncarry += ncarry >>> 26;
		        ncarry &= 0x3ffffff;
		      }
		      out.words[k] = rword;
		      carry = ncarry;
		      ncarry = hncarry;
		    }
		    if (carry !== 0) {
		      out.words[k] = carry;
		    } else {
		      out.length--;
		    }

		    return out._strip();
		  }

		  function jumboMulTo (self, num, out) {
		    // Temporary disable, see https://github.com/indutny/bn.js/issues/211
		    // var fftm = new FFTM();
		    // return fftm.mulp(self, num, out);
		    return bigMulTo(self, num, out);
		  }

		  BN.prototype.mulTo = function mulTo (num, out) {
		    var res;
		    var len = this.length + num.length;
		    if (this.length === 10 && num.length === 10) {
		      res = comb10MulTo(this, num, out);
		    } else if (len < 63) {
		      res = smallMulTo(this, num, out);
		    } else if (len < 1024) {
		      res = bigMulTo(this, num, out);
		    } else {
		      res = jumboMulTo(this, num, out);
		    }

		    return res;
		  };

		  // Multiply `this` by `num`
		  BN.prototype.mul = function mul (num) {
		    var out = new BN(null);
		    out.words = new Array(this.length + num.length);
		    return this.mulTo(num, out);
		  };

		  // Multiply employing FFT
		  BN.prototype.mulf = function mulf (num) {
		    var out = new BN(null);
		    out.words = new Array(this.length + num.length);
		    return jumboMulTo(this, num, out);
		  };

		  // In-place Multiplication
		  BN.prototype.imul = function imul (num) {
		    return this.clone().mulTo(num, this);
		  };

		  BN.prototype.imuln = function imuln (num) {
		    var isNegNum = num < 0;
		    if (isNegNum) num = -num;

		    assert(typeof num === 'number');
		    assert(num < 0x4000000);

		    // Carry
		    var carry = 0;
		    for (var i = 0; i < this.length; i++) {
		      var w = (this.words[i] | 0) * num;
		      var lo = (w & 0x3ffffff) + (carry & 0x3ffffff);
		      carry >>= 26;
		      carry += (w / 0x4000000) | 0;
		      // NOTE: lo is 27bit maximum
		      carry += lo >>> 26;
		      this.words[i] = lo & 0x3ffffff;
		    }

		    if (carry !== 0) {
		      this.words[i] = carry;
		      this.length++;
		    }
		    this.length = num === 0 ? 1 : this.length;

		    return isNegNum ? this.ineg() : this;
		  };

		  BN.prototype.muln = function muln (num) {
		    return this.clone().imuln(num);
		  };

		  // `this` * `this`
		  BN.prototype.sqr = function sqr () {
		    return this.mul(this);
		  };

		  // `this` * `this` in-place
		  BN.prototype.isqr = function isqr () {
		    return this.imul(this.clone());
		  };

		  // Math.pow(`this`, `num`)
		  BN.prototype.pow = function pow (num) {
		    var w = toBitArray(num);
		    if (w.length === 0) return new BN(1);

		    // Skip leading zeroes
		    var res = this;
		    for (var i = 0; i < w.length; i++, res = res.sqr()) {
		      if (w[i] !== 0) break;
		    }

		    if (++i < w.length) {
		      for (var q = res.sqr(); i < w.length; i++, q = q.sqr()) {
		        if (w[i] === 0) continue;

		        res = res.mul(q);
		      }
		    }

		    return res;
		  };

		  // Shift-left in-place
		  BN.prototype.iushln = function iushln (bits) {
		    assert(typeof bits === 'number' && bits >= 0);
		    var r = bits % 26;
		    var s = (bits - r) / 26;
		    var carryMask = (0x3ffffff >>> (26 - r)) << (26 - r);
		    var i;

		    if (r !== 0) {
		      var carry = 0;

		      for (i = 0; i < this.length; i++) {
		        var newCarry = this.words[i] & carryMask;
		        var c = ((this.words[i] | 0) - newCarry) << r;
		        this.words[i] = c | carry;
		        carry = newCarry >>> (26 - r);
		      }

		      if (carry) {
		        this.words[i] = carry;
		        this.length++;
		      }
		    }

		    if (s !== 0) {
		      for (i = this.length - 1; i >= 0; i--) {
		        this.words[i + s] = this.words[i];
		      }

		      for (i = 0; i < s; i++) {
		        this.words[i] = 0;
		      }

		      this.length += s;
		    }

		    return this._strip();
		  };

		  BN.prototype.ishln = function ishln (bits) {
		    // TODO(indutny): implement me
		    assert(this.negative === 0);
		    return this.iushln(bits);
		  };

		  // Shift-right in-place
		  // NOTE: `hint` is a lowest bit before trailing zeroes
		  // NOTE: if `extended` is present - it will be filled with destroyed bits
		  BN.prototype.iushrn = function iushrn (bits, hint, extended) {
		    assert(typeof bits === 'number' && bits >= 0);
		    var h;
		    if (hint) {
		      h = (hint - (hint % 26)) / 26;
		    } else {
		      h = 0;
		    }

		    var r = bits % 26;
		    var s = Math.min((bits - r) / 26, this.length);
		    var mask = 0x3ffffff ^ ((0x3ffffff >>> r) << r);
		    var maskedWords = extended;

		    h -= s;
		    h = Math.max(0, h);

		    // Extended mode, copy masked part
		    if (maskedWords) {
		      for (var i = 0; i < s; i++) {
		        maskedWords.words[i] = this.words[i];
		      }
		      maskedWords.length = s;
		    }

		    if (s === 0) ; else if (this.length > s) {
		      this.length -= s;
		      for (i = 0; i < this.length; i++) {
		        this.words[i] = this.words[i + s];
		      }
		    } else {
		      this.words[0] = 0;
		      this.length = 1;
		    }

		    var carry = 0;
		    for (i = this.length - 1; i >= 0 && (carry !== 0 || i >= h); i--) {
		      var word = this.words[i] | 0;
		      this.words[i] = (carry << (26 - r)) | (word >>> r);
		      carry = word & mask;
		    }

		    // Push carried bits as a mask
		    if (maskedWords && carry !== 0) {
		      maskedWords.words[maskedWords.length++] = carry;
		    }

		    if (this.length === 0) {
		      this.words[0] = 0;
		      this.length = 1;
		    }

		    return this._strip();
		  };

		  BN.prototype.ishrn = function ishrn (bits, hint, extended) {
		    // TODO(indutny): implement me
		    assert(this.negative === 0);
		    return this.iushrn(bits, hint, extended);
		  };

		  // Shift-left
		  BN.prototype.shln = function shln (bits) {
		    return this.clone().ishln(bits);
		  };

		  BN.prototype.ushln = function ushln (bits) {
		    return this.clone().iushln(bits);
		  };

		  // Shift-right
		  BN.prototype.shrn = function shrn (bits) {
		    return this.clone().ishrn(bits);
		  };

		  BN.prototype.ushrn = function ushrn (bits) {
		    return this.clone().iushrn(bits);
		  };

		  // Test if n bit is set
		  BN.prototype.testn = function testn (bit) {
		    assert(typeof bit === 'number' && bit >= 0);
		    var r = bit % 26;
		    var s = (bit - r) / 26;
		    var q = 1 << r;

		    // Fast case: bit is much higher than all existing words
		    if (this.length <= s) return false;

		    // Check bit and return
		    var w = this.words[s];

		    return !!(w & q);
		  };

		  // Return only lowers bits of number (in-place)
		  BN.prototype.imaskn = function imaskn (bits) {
		    assert(typeof bits === 'number' && bits >= 0);
		    var r = bits % 26;
		    var s = (bits - r) / 26;

		    assert(this.negative === 0, 'imaskn works only with positive numbers');

		    if (this.length <= s) {
		      return this;
		    }

		    if (r !== 0) {
		      s++;
		    }
		    this.length = Math.min(s, this.length);

		    if (r !== 0) {
		      var mask = 0x3ffffff ^ ((0x3ffffff >>> r) << r);
		      this.words[this.length - 1] &= mask;
		    }

		    return this._strip();
		  };

		  // Return only lowers bits of number
		  BN.prototype.maskn = function maskn (bits) {
		    return this.clone().imaskn(bits);
		  };

		  // Add plain number `num` to `this`
		  BN.prototype.iaddn = function iaddn (num) {
		    assert(typeof num === 'number');
		    assert(num < 0x4000000);
		    if (num < 0) return this.isubn(-num);

		    // Possible sign change
		    if (this.negative !== 0) {
		      if (this.length === 1 && (this.words[0] | 0) <= num) {
		        this.words[0] = num - (this.words[0] | 0);
		        this.negative = 0;
		        return this;
		      }

		      this.negative = 0;
		      this.isubn(num);
		      this.negative = 1;
		      return this;
		    }

		    // Add without checks
		    return this._iaddn(num);
		  };

		  BN.prototype._iaddn = function _iaddn (num) {
		    this.words[0] += num;

		    // Carry
		    for (var i = 0; i < this.length && this.words[i] >= 0x4000000; i++) {
		      this.words[i] -= 0x4000000;
		      if (i === this.length - 1) {
		        this.words[i + 1] = 1;
		      } else {
		        this.words[i + 1]++;
		      }
		    }
		    this.length = Math.max(this.length, i + 1);

		    return this;
		  };

		  // Subtract plain number `num` from `this`
		  BN.prototype.isubn = function isubn (num) {
		    assert(typeof num === 'number');
		    assert(num < 0x4000000);
		    if (num < 0) return this.iaddn(-num);

		    if (this.negative !== 0) {
		      this.negative = 0;
		      this.iaddn(num);
		      this.negative = 1;
		      return this;
		    }

		    this.words[0] -= num;

		    if (this.length === 1 && this.words[0] < 0) {
		      this.words[0] = -this.words[0];
		      this.negative = 1;
		    } else {
		      // Carry
		      for (var i = 0; i < this.length && this.words[i] < 0; i++) {
		        this.words[i] += 0x4000000;
		        this.words[i + 1] -= 1;
		      }
		    }

		    return this._strip();
		  };

		  BN.prototype.addn = function addn (num) {
		    return this.clone().iaddn(num);
		  };

		  BN.prototype.subn = function subn (num) {
		    return this.clone().isubn(num);
		  };

		  BN.prototype.iabs = function iabs () {
		    this.negative = 0;

		    return this;
		  };

		  BN.prototype.abs = function abs () {
		    return this.clone().iabs();
		  };

		  BN.prototype._ishlnsubmul = function _ishlnsubmul (num, mul, shift) {
		    var len = num.length + shift;
		    var i;

		    this._expand(len);

		    var w;
		    var carry = 0;
		    for (i = 0; i < num.length; i++) {
		      w = (this.words[i + shift] | 0) + carry;
		      var right = (num.words[i] | 0) * mul;
		      w -= right & 0x3ffffff;
		      carry = (w >> 26) - ((right / 0x4000000) | 0);
		      this.words[i + shift] = w & 0x3ffffff;
		    }
		    for (; i < this.length - shift; i++) {
		      w = (this.words[i + shift] | 0) + carry;
		      carry = w >> 26;
		      this.words[i + shift] = w & 0x3ffffff;
		    }

		    if (carry === 0) return this._strip();

		    // Subtraction overflow
		    assert(carry === -1);
		    carry = 0;
		    for (i = 0; i < this.length; i++) {
		      w = -(this.words[i] | 0) + carry;
		      carry = w >> 26;
		      this.words[i] = w & 0x3ffffff;
		    }
		    this.negative = 1;

		    return this._strip();
		  };

		  BN.prototype._wordDiv = function _wordDiv (num, mode) {
		    var shift = this.length - num.length;

		    var a = this.clone();
		    var b = num;

		    // Normalize
		    var bhi = b.words[b.length - 1] | 0;
		    var bhiBits = this._countBits(bhi);
		    shift = 26 - bhiBits;
		    if (shift !== 0) {
		      b = b.ushln(shift);
		      a.iushln(shift);
		      bhi = b.words[b.length - 1] | 0;
		    }

		    // Initialize quotient
		    var m = a.length - b.length;
		    var q;

		    if (mode !== 'mod') {
		      q = new BN(null);
		      q.length = m + 1;
		      q.words = new Array(q.length);
		      for (var i = 0; i < q.length; i++) {
		        q.words[i] = 0;
		      }
		    }

		    var diff = a.clone()._ishlnsubmul(b, 1, m);
		    if (diff.negative === 0) {
		      a = diff;
		      if (q) {
		        q.words[m] = 1;
		      }
		    }

		    for (var j = m - 1; j >= 0; j--) {
		      var qj = (a.words[b.length + j] | 0) * 0x4000000 +
		        (a.words[b.length + j - 1] | 0);

		      // NOTE: (qj / bhi) is (0x3ffffff * 0x4000000 + 0x3ffffff) / 0x2000000 max
		      // (0x7ffffff)
		      qj = Math.min((qj / bhi) | 0, 0x3ffffff);

		      a._ishlnsubmul(b, qj, j);
		      while (a.negative !== 0) {
		        qj--;
		        a.negative = 0;
		        a._ishlnsubmul(b, 1, j);
		        if (!a.isZero()) {
		          a.negative ^= 1;
		        }
		      }
		      if (q) {
		        q.words[j] = qj;
		      }
		    }
		    if (q) {
		      q._strip();
		    }
		    a._strip();

		    // Denormalize
		    if (mode !== 'div' && shift !== 0) {
		      a.iushrn(shift);
		    }

		    return {
		      div: q || null,
		      mod: a
		    };
		  };

		  // NOTE: 1) `mode` can be set to `mod` to request mod only,
		  //       to `div` to request div only, or be absent to
		  //       request both div & mod
		  //       2) `positive` is true if unsigned mod is requested
		  BN.prototype.divmod = function divmod (num, mode, positive) {
		    assert(!num.isZero());

		    if (this.isZero()) {
		      return {
		        div: new BN(0),
		        mod: new BN(0)
		      };
		    }

		    var div, mod, res;
		    if (this.negative !== 0 && num.negative === 0) {
		      res = this.neg().divmod(num, mode);

		      if (mode !== 'mod') {
		        div = res.div.neg();
		      }

		      if (mode !== 'div') {
		        mod = res.mod.neg();
		        if (positive && mod.negative !== 0) {
		          mod.iadd(num);
		        }
		      }

		      return {
		        div: div,
		        mod: mod
		      };
		    }

		    if (this.negative === 0 && num.negative !== 0) {
		      res = this.divmod(num.neg(), mode);

		      if (mode !== 'mod') {
		        div = res.div.neg();
		      }

		      return {
		        div: div,
		        mod: res.mod
		      };
		    }

		    if ((this.negative & num.negative) !== 0) {
		      res = this.neg().divmod(num.neg(), mode);

		      if (mode !== 'div') {
		        mod = res.mod.neg();
		        if (positive && mod.negative !== 0) {
		          mod.isub(num);
		        }
		      }

		      return {
		        div: res.div,
		        mod: mod
		      };
		    }

		    // Both numbers are positive at this point

		    // Strip both numbers to approximate shift value
		    if (num.length > this.length || this.cmp(num) < 0) {
		      return {
		        div: new BN(0),
		        mod: this
		      };
		    }

		    // Very short reduction
		    if (num.length === 1) {
		      if (mode === 'div') {
		        return {
		          div: this.divn(num.words[0]),
		          mod: null
		        };
		      }

		      if (mode === 'mod') {
		        return {
		          div: null,
		          mod: new BN(this.modrn(num.words[0]))
		        };
		      }

		      return {
		        div: this.divn(num.words[0]),
		        mod: new BN(this.modrn(num.words[0]))
		      };
		    }

		    return this._wordDiv(num, mode);
		  };

		  // Find `this` / `num`
		  BN.prototype.div = function div (num) {
		    return this.divmod(num, 'div', false).div;
		  };

		  // Find `this` % `num`
		  BN.prototype.mod = function mod (num) {
		    return this.divmod(num, 'mod', false).mod;
		  };

		  BN.prototype.umod = function umod (num) {
		    return this.divmod(num, 'mod', true).mod;
		  };

		  // Find Round(`this` / `num`)
		  BN.prototype.divRound = function divRound (num) {
		    var dm = this.divmod(num);

		    // Fast case - exact division
		    if (dm.mod.isZero()) return dm.div;

		    var mod = dm.div.negative !== 0 ? dm.mod.isub(num) : dm.mod;

		    var half = num.ushrn(1);
		    var r2 = num.andln(1);
		    var cmp = mod.cmp(half);

		    // Round down
		    if (cmp < 0 || (r2 === 1 && cmp === 0)) return dm.div;

		    // Round up
		    return dm.div.negative !== 0 ? dm.div.isubn(1) : dm.div.iaddn(1);
		  };

		  BN.prototype.modrn = function modrn (num) {
		    var isNegNum = num < 0;
		    if (isNegNum) num = -num;

		    assert(num <= 0x3ffffff);
		    var p = (1 << 26) % num;

		    var acc = 0;
		    for (var i = this.length - 1; i >= 0; i--) {
		      acc = (p * acc + (this.words[i] | 0)) % num;
		    }

		    return isNegNum ? -acc : acc;
		  };

		  // WARNING: DEPRECATED
		  BN.prototype.modn = function modn (num) {
		    return this.modrn(num);
		  };

		  // In-place division by number
		  BN.prototype.idivn = function idivn (num) {
		    var isNegNum = num < 0;
		    if (isNegNum) num = -num;

		    assert(num <= 0x3ffffff);

		    var carry = 0;
		    for (var i = this.length - 1; i >= 0; i--) {
		      var w = (this.words[i] | 0) + carry * 0x4000000;
		      this.words[i] = (w / num) | 0;
		      carry = w % num;
		    }

		    this._strip();
		    return isNegNum ? this.ineg() : this;
		  };

		  BN.prototype.divn = function divn (num) {
		    return this.clone().idivn(num);
		  };

		  BN.prototype.egcd = function egcd (p) {
		    assert(p.negative === 0);
		    assert(!p.isZero());

		    var x = this;
		    var y = p.clone();

		    if (x.negative !== 0) {
		      x = x.umod(p);
		    } else {
		      x = x.clone();
		    }

		    // A * x + B * y = x
		    var A = new BN(1);
		    var B = new BN(0);

		    // C * x + D * y = y
		    var C = new BN(0);
		    var D = new BN(1);

		    var g = 0;

		    while (x.isEven() && y.isEven()) {
		      x.iushrn(1);
		      y.iushrn(1);
		      ++g;
		    }

		    var yp = y.clone();
		    var xp = x.clone();

		    while (!x.isZero()) {
		      for (var i = 0, im = 1; (x.words[0] & im) === 0 && i < 26; ++i, im <<= 1);
		      if (i > 0) {
		        x.iushrn(i);
		        while (i-- > 0) {
		          if (A.isOdd() || B.isOdd()) {
		            A.iadd(yp);
		            B.isub(xp);
		          }

		          A.iushrn(1);
		          B.iushrn(1);
		        }
		      }

		      for (var j = 0, jm = 1; (y.words[0] & jm) === 0 && j < 26; ++j, jm <<= 1);
		      if (j > 0) {
		        y.iushrn(j);
		        while (j-- > 0) {
		          if (C.isOdd() || D.isOdd()) {
		            C.iadd(yp);
		            D.isub(xp);
		          }

		          C.iushrn(1);
		          D.iushrn(1);
		        }
		      }

		      if (x.cmp(y) >= 0) {
		        x.isub(y);
		        A.isub(C);
		        B.isub(D);
		      } else {
		        y.isub(x);
		        C.isub(A);
		        D.isub(B);
		      }
		    }

		    return {
		      a: C,
		      b: D,
		      gcd: y.iushln(g)
		    };
		  };

		  // This is reduced incarnation of the binary EEA
		  // above, designated to invert members of the
		  // _prime_ fields F(p) at a maximal speed
		  BN.prototype._invmp = function _invmp (p) {
		    assert(p.negative === 0);
		    assert(!p.isZero());

		    var a = this;
		    var b = p.clone();

		    if (a.negative !== 0) {
		      a = a.umod(p);
		    } else {
		      a = a.clone();
		    }

		    var x1 = new BN(1);
		    var x2 = new BN(0);

		    var delta = b.clone();

		    while (a.cmpn(1) > 0 && b.cmpn(1) > 0) {
		      for (var i = 0, im = 1; (a.words[0] & im) === 0 && i < 26; ++i, im <<= 1);
		      if (i > 0) {
		        a.iushrn(i);
		        while (i-- > 0) {
		          if (x1.isOdd()) {
		            x1.iadd(delta);
		          }

		          x1.iushrn(1);
		        }
		      }

		      for (var j = 0, jm = 1; (b.words[0] & jm) === 0 && j < 26; ++j, jm <<= 1);
		      if (j > 0) {
		        b.iushrn(j);
		        while (j-- > 0) {
		          if (x2.isOdd()) {
		            x2.iadd(delta);
		          }

		          x2.iushrn(1);
		        }
		      }

		      if (a.cmp(b) >= 0) {
		        a.isub(b);
		        x1.isub(x2);
		      } else {
		        b.isub(a);
		        x2.isub(x1);
		      }
		    }

		    var res;
		    if (a.cmpn(1) === 0) {
		      res = x1;
		    } else {
		      res = x2;
		    }

		    if (res.cmpn(0) < 0) {
		      res.iadd(p);
		    }

		    return res;
		  };

		  BN.prototype.gcd = function gcd (num) {
		    if (this.isZero()) return num.abs();
		    if (num.isZero()) return this.abs();

		    var a = this.clone();
		    var b = num.clone();
		    a.negative = 0;
		    b.negative = 0;

		    // Remove common factor of two
		    for (var shift = 0; a.isEven() && b.isEven(); shift++) {
		      a.iushrn(1);
		      b.iushrn(1);
		    }

		    do {
		      while (a.isEven()) {
		        a.iushrn(1);
		      }
		      while (b.isEven()) {
		        b.iushrn(1);
		      }

		      var r = a.cmp(b);
		      if (r < 0) {
		        // Swap `a` and `b` to make `a` always bigger than `b`
		        var t = a;
		        a = b;
		        b = t;
		      } else if (r === 0 || b.cmpn(1) === 0) {
		        break;
		      }

		      a.isub(b);
		    } while (true);

		    return b.iushln(shift);
		  };

		  // Invert number in the field F(num)
		  BN.prototype.invm = function invm (num) {
		    return this.egcd(num).a.umod(num);
		  };

		  BN.prototype.isEven = function isEven () {
		    return (this.words[0] & 1) === 0;
		  };

		  BN.prototype.isOdd = function isOdd () {
		    return (this.words[0] & 1) === 1;
		  };

		  // And first word and num
		  BN.prototype.andln = function andln (num) {
		    return this.words[0] & num;
		  };

		  // Increment at the bit position in-line
		  BN.prototype.bincn = function bincn (bit) {
		    assert(typeof bit === 'number');
		    var r = bit % 26;
		    var s = (bit - r) / 26;
		    var q = 1 << r;

		    // Fast case: bit is much higher than all existing words
		    if (this.length <= s) {
		      this._expand(s + 1);
		      this.words[s] |= q;
		      return this;
		    }

		    // Add bit and propagate, if needed
		    var carry = q;
		    for (var i = s; carry !== 0 && i < this.length; i++) {
		      var w = this.words[i] | 0;
		      w += carry;
		      carry = w >>> 26;
		      w &= 0x3ffffff;
		      this.words[i] = w;
		    }
		    if (carry !== 0) {
		      this.words[i] = carry;
		      this.length++;
		    }
		    return this;
		  };

		  BN.prototype.isZero = function isZero () {
		    return this.length === 1 && this.words[0] === 0;
		  };

		  BN.prototype.cmpn = function cmpn (num) {
		    var negative = num < 0;

		    if (this.negative !== 0 && !negative) return -1;
		    if (this.negative === 0 && negative) return 1;

		    this._strip();

		    var res;
		    if (this.length > 1) {
		      res = 1;
		    } else {
		      if (negative) {
		        num = -num;
		      }

		      assert(num <= 0x3ffffff, 'Number is too big');

		      var w = this.words[0] | 0;
		      res = w === num ? 0 : w < num ? -1 : 1;
		    }
		    if (this.negative !== 0) return -res | 0;
		    return res;
		  };

		  // Compare two numbers and return:
		  // 1 - if `this` > `num`
		  // 0 - if `this` == `num`
		  // -1 - if `this` < `num`
		  BN.prototype.cmp = function cmp (num) {
		    if (this.negative !== 0 && num.negative === 0) return -1;
		    if (this.negative === 0 && num.negative !== 0) return 1;

		    var res = this.ucmp(num);
		    if (this.negative !== 0) return -res | 0;
		    return res;
		  };

		  // Unsigned comparison
		  BN.prototype.ucmp = function ucmp (num) {
		    // At this point both numbers have the same sign
		    if (this.length > num.length) return 1;
		    if (this.length < num.length) return -1;

		    var res = 0;
		    for (var i = this.length - 1; i >= 0; i--) {
		      var a = this.words[i] | 0;
		      var b = num.words[i] | 0;

		      if (a === b) continue;
		      if (a < b) {
		        res = -1;
		      } else if (a > b) {
		        res = 1;
		      }
		      break;
		    }
		    return res;
		  };

		  BN.prototype.gtn = function gtn (num) {
		    return this.cmpn(num) === 1;
		  };

		  BN.prototype.gt = function gt (num) {
		    return this.cmp(num) === 1;
		  };

		  BN.prototype.gten = function gten (num) {
		    return this.cmpn(num) >= 0;
		  };

		  BN.prototype.gte = function gte (num) {
		    return this.cmp(num) >= 0;
		  };

		  BN.prototype.ltn = function ltn (num) {
		    return this.cmpn(num) === -1;
		  };

		  BN.prototype.lt = function lt (num) {
		    return this.cmp(num) === -1;
		  };

		  BN.prototype.lten = function lten (num) {
		    return this.cmpn(num) <= 0;
		  };

		  BN.prototype.lte = function lte (num) {
		    return this.cmp(num) <= 0;
		  };

		  BN.prototype.eqn = function eqn (num) {
		    return this.cmpn(num) === 0;
		  };

		  BN.prototype.eq = function eq (num) {
		    return this.cmp(num) === 0;
		  };

		  //
		  // A reduce context, could be using montgomery or something better, depending
		  // on the `m` itself.
		  //
		  BN.red = function red (num) {
		    return new Red(num);
		  };

		  BN.prototype.toRed = function toRed (ctx) {
		    assert(!this.red, 'Already a number in reduction context');
		    assert(this.negative === 0, 'red works only with positives');
		    return ctx.convertTo(this)._forceRed(ctx);
		  };

		  BN.prototype.fromRed = function fromRed () {
		    assert(this.red, 'fromRed works only with numbers in reduction context');
		    return this.red.convertFrom(this);
		  };

		  BN.prototype._forceRed = function _forceRed (ctx) {
		    this.red = ctx;
		    return this;
		  };

		  BN.prototype.forceRed = function forceRed (ctx) {
		    assert(!this.red, 'Already a number in reduction context');
		    return this._forceRed(ctx);
		  };

		  BN.prototype.redAdd = function redAdd (num) {
		    assert(this.red, 'redAdd works only with red numbers');
		    return this.red.add(this, num);
		  };

		  BN.prototype.redIAdd = function redIAdd (num) {
		    assert(this.red, 'redIAdd works only with red numbers');
		    return this.red.iadd(this, num);
		  };

		  BN.prototype.redSub = function redSub (num) {
		    assert(this.red, 'redSub works only with red numbers');
		    return this.red.sub(this, num);
		  };

		  BN.prototype.redISub = function redISub (num) {
		    assert(this.red, 'redISub works only with red numbers');
		    return this.red.isub(this, num);
		  };

		  BN.prototype.redShl = function redShl (num) {
		    assert(this.red, 'redShl works only with red numbers');
		    return this.red.shl(this, num);
		  };

		  BN.prototype.redMul = function redMul (num) {
		    assert(this.red, 'redMul works only with red numbers');
		    this.red._verify2(this, num);
		    return this.red.mul(this, num);
		  };

		  BN.prototype.redIMul = function redIMul (num) {
		    assert(this.red, 'redMul works only with red numbers');
		    this.red._verify2(this, num);
		    return this.red.imul(this, num);
		  };

		  BN.prototype.redSqr = function redSqr () {
		    assert(this.red, 'redSqr works only with red numbers');
		    this.red._verify1(this);
		    return this.red.sqr(this);
		  };

		  BN.prototype.redISqr = function redISqr () {
		    assert(this.red, 'redISqr works only with red numbers');
		    this.red._verify1(this);
		    return this.red.isqr(this);
		  };

		  // Square root over p
		  BN.prototype.redSqrt = function redSqrt () {
		    assert(this.red, 'redSqrt works only with red numbers');
		    this.red._verify1(this);
		    return this.red.sqrt(this);
		  };

		  BN.prototype.redInvm = function redInvm () {
		    assert(this.red, 'redInvm works only with red numbers');
		    this.red._verify1(this);
		    return this.red.invm(this);
		  };

		  // Return negative clone of `this` % `red modulo`
		  BN.prototype.redNeg = function redNeg () {
		    assert(this.red, 'redNeg works only with red numbers');
		    this.red._verify1(this);
		    return this.red.neg(this);
		  };

		  BN.prototype.redPow = function redPow (num) {
		    assert(this.red && !num.red, 'redPow(normalNum)');
		    this.red._verify1(this);
		    return this.red.pow(this, num);
		  };

		  // Prime numbers with efficient reduction
		  var primes = {
		    k256: null,
		    p224: null,
		    p192: null,
		    p25519: null
		  };

		  // Pseudo-Mersenne prime
		  function MPrime (name, p) {
		    // P = 2 ^ N - K
		    this.name = name;
		    this.p = new BN(p, 16);
		    this.n = this.p.bitLength();
		    this.k = new BN(1).iushln(this.n).isub(this.p);

		    this.tmp = this._tmp();
		  }

		  MPrime.prototype._tmp = function _tmp () {
		    var tmp = new BN(null);
		    tmp.words = new Array(Math.ceil(this.n / 13));
		    return tmp;
		  };

		  MPrime.prototype.ireduce = function ireduce (num) {
		    // Assumes that `num` is less than `P^2`
		    // num = HI * (2 ^ N - K) + HI * K + LO = HI * K + LO (mod P)
		    var r = num;
		    var rlen;

		    do {
		      this.split(r, this.tmp);
		      r = this.imulK(r);
		      r = r.iadd(this.tmp);
		      rlen = r.bitLength();
		    } while (rlen > this.n);

		    var cmp = rlen < this.n ? -1 : r.ucmp(this.p);
		    if (cmp === 0) {
		      r.words[0] = 0;
		      r.length = 1;
		    } else if (cmp > 0) {
		      r.isub(this.p);
		    } else {
		      if (r.strip !== undefined) {
		        // r is a BN v4 instance
		        r.strip();
		      } else {
		        // r is a BN v5 instance
		        r._strip();
		      }
		    }

		    return r;
		  };

		  MPrime.prototype.split = function split (input, out) {
		    input.iushrn(this.n, 0, out);
		  };

		  MPrime.prototype.imulK = function imulK (num) {
		    return num.imul(this.k);
		  };

		  function K256 () {
		    MPrime.call(
		      this,
		      'k256',
		      'ffffffff ffffffff ffffffff ffffffff ffffffff ffffffff fffffffe fffffc2f');
		  }
		  inherits(K256, MPrime);

		  K256.prototype.split = function split (input, output) {
		    // 256 = 9 * 26 + 22
		    var mask = 0x3fffff;

		    var outLen = Math.min(input.length, 9);
		    for (var i = 0; i < outLen; i++) {
		      output.words[i] = input.words[i];
		    }
		    output.length = outLen;

		    if (input.length <= 9) {
		      input.words[0] = 0;
		      input.length = 1;
		      return;
		    }

		    // Shift by 9 limbs
		    var prev = input.words[9];
		    output.words[output.length++] = prev & mask;

		    for (i = 10; i < input.length; i++) {
		      var next = input.words[i] | 0;
		      input.words[i - 10] = ((next & mask) << 4) | (prev >>> 22);
		      prev = next;
		    }
		    prev >>>= 22;
		    input.words[i - 10] = prev;
		    if (prev === 0 && input.length > 10) {
		      input.length -= 10;
		    } else {
		      input.length -= 9;
		    }
		  };

		  K256.prototype.imulK = function imulK (num) {
		    // K = 0x1000003d1 = [ 0x40, 0x3d1 ]
		    num.words[num.length] = 0;
		    num.words[num.length + 1] = 0;
		    num.length += 2;

		    // bounded at: 0x40 * 0x3ffffff + 0x3d0 = 0x100000390
		    var lo = 0;
		    for (var i = 0; i < num.length; i++) {
		      var w = num.words[i] | 0;
		      lo += w * 0x3d1;
		      num.words[i] = lo & 0x3ffffff;
		      lo = w * 0x40 + ((lo / 0x4000000) | 0);
		    }

		    // Fast length reduction
		    if (num.words[num.length - 1] === 0) {
		      num.length--;
		      if (num.words[num.length - 1] === 0) {
		        num.length--;
		      }
		    }
		    return num;
		  };

		  function P224 () {
		    MPrime.call(
		      this,
		      'p224',
		      'ffffffff ffffffff ffffffff ffffffff 00000000 00000000 00000001');
		  }
		  inherits(P224, MPrime);

		  function P192 () {
		    MPrime.call(
		      this,
		      'p192',
		      'ffffffff ffffffff ffffffff fffffffe ffffffff ffffffff');
		  }
		  inherits(P192, MPrime);

		  function P25519 () {
		    // 2 ^ 255 - 19
		    MPrime.call(
		      this,
		      '25519',
		      '7fffffffffffffff ffffffffffffffff ffffffffffffffff ffffffffffffffed');
		  }
		  inherits(P25519, MPrime);

		  P25519.prototype.imulK = function imulK (num) {
		    // K = 0x13
		    var carry = 0;
		    for (var i = 0; i < num.length; i++) {
		      var hi = (num.words[i] | 0) * 0x13 + carry;
		      var lo = hi & 0x3ffffff;
		      hi >>>= 26;

		      num.words[i] = lo;
		      carry = hi;
		    }
		    if (carry !== 0) {
		      num.words[num.length++] = carry;
		    }
		    return num;
		  };

		  // Exported mostly for testing purposes, use plain name instead
		  BN._prime = function prime (name) {
		    // Cached version of prime
		    if (primes[name]) return primes[name];

		    var prime;
		    if (name === 'k256') {
		      prime = new K256();
		    } else if (name === 'p224') {
		      prime = new P224();
		    } else if (name === 'p192') {
		      prime = new P192();
		    } else if (name === 'p25519') {
		      prime = new P25519();
		    } else {
		      throw new Error('Unknown prime ' + name);
		    }
		    primes[name] = prime;

		    return prime;
		  };

		  //
		  // Base reduction engine
		  //
		  function Red (m) {
		    if (typeof m === 'string') {
		      var prime = BN._prime(m);
		      this.m = prime.p;
		      this.prime = prime;
		    } else {
		      assert(m.gtn(1), 'modulus must be greater than 1');
		      this.m = m;
		      this.prime = null;
		    }
		  }

		  Red.prototype._verify1 = function _verify1 (a) {
		    assert(a.negative === 0, 'red works only with positives');
		    assert(a.red, 'red works only with red numbers');
		  };

		  Red.prototype._verify2 = function _verify2 (a, b) {
		    assert((a.negative | b.negative) === 0, 'red works only with positives');
		    assert(a.red && a.red === b.red,
		      'red works only with red numbers');
		  };

		  Red.prototype.imod = function imod (a) {
		    if (this.prime) return this.prime.ireduce(a)._forceRed(this);

		    move(a, a.umod(this.m)._forceRed(this));
		    return a;
		  };

		  Red.prototype.neg = function neg (a) {
		    if (a.isZero()) {
		      return a.clone();
		    }

		    return this.m.sub(a)._forceRed(this);
		  };

		  Red.prototype.add = function add (a, b) {
		    this._verify2(a, b);

		    var res = a.add(b);
		    if (res.cmp(this.m) >= 0) {
		      res.isub(this.m);
		    }
		    return res._forceRed(this);
		  };

		  Red.prototype.iadd = function iadd (a, b) {
		    this._verify2(a, b);

		    var res = a.iadd(b);
		    if (res.cmp(this.m) >= 0) {
		      res.isub(this.m);
		    }
		    return res;
		  };

		  Red.prototype.sub = function sub (a, b) {
		    this._verify2(a, b);

		    var res = a.sub(b);
		    if (res.cmpn(0) < 0) {
		      res.iadd(this.m);
		    }
		    return res._forceRed(this);
		  };

		  Red.prototype.isub = function isub (a, b) {
		    this._verify2(a, b);

		    var res = a.isub(b);
		    if (res.cmpn(0) < 0) {
		      res.iadd(this.m);
		    }
		    return res;
		  };

		  Red.prototype.shl = function shl (a, num) {
		    this._verify1(a);
		    return this.imod(a.ushln(num));
		  };

		  Red.prototype.imul = function imul (a, b) {
		    this._verify2(a, b);
		    return this.imod(a.imul(b));
		  };

		  Red.prototype.mul = function mul (a, b) {
		    this._verify2(a, b);
		    return this.imod(a.mul(b));
		  };

		  Red.prototype.isqr = function isqr (a) {
		    return this.imul(a, a.clone());
		  };

		  Red.prototype.sqr = function sqr (a) {
		    return this.mul(a, a);
		  };

		  Red.prototype.sqrt = function sqrt (a) {
		    if (a.isZero()) return a.clone();

		    var mod3 = this.m.andln(3);
		    assert(mod3 % 2 === 1);

		    // Fast case
		    if (mod3 === 3) {
		      var pow = this.m.add(new BN(1)).iushrn(2);
		      return this.pow(a, pow);
		    }

		    // Tonelli-Shanks algorithm (Totally unoptimized and slow)
		    //
		    // Find Q and S, that Q * 2 ^ S = (P - 1)
		    var q = this.m.subn(1);
		    var s = 0;
		    while (!q.isZero() && q.andln(1) === 0) {
		      s++;
		      q.iushrn(1);
		    }
		    assert(!q.isZero());

		    var one = new BN(1).toRed(this);
		    var nOne = one.redNeg();

		    // Find quadratic non-residue
		    // NOTE: Max is such because of generalized Riemann hypothesis.
		    var lpow = this.m.subn(1).iushrn(1);
		    var z = this.m.bitLength();
		    z = new BN(2 * z * z).toRed(this);

		    while (this.pow(z, lpow).cmp(nOne) !== 0) {
		      z.redIAdd(nOne);
		    }

		    var c = this.pow(z, q);
		    var r = this.pow(a, q.addn(1).iushrn(1));
		    var t = this.pow(a, q);
		    var m = s;
		    while (t.cmp(one) !== 0) {
		      var tmp = t;
		      for (var i = 0; tmp.cmp(one) !== 0; i++) {
		        tmp = tmp.redSqr();
		      }
		      assert(i < m);
		      var b = this.pow(c, new BN(1).iushln(m - i - 1));

		      r = r.redMul(b);
		      c = b.redSqr();
		      t = t.redMul(c);
		      m = i;
		    }

		    return r;
		  };

		  Red.prototype.invm = function invm (a) {
		    var inv = a._invmp(this.m);
		    if (inv.negative !== 0) {
		      inv.negative = 0;
		      return this.imod(inv).redNeg();
		    } else {
		      return this.imod(inv);
		    }
		  };

		  Red.prototype.pow = function pow (a, num) {
		    if (num.isZero()) return new BN(1).toRed(this);
		    if (num.cmpn(1) === 0) return a.clone();

		    var windowSize = 4;
		    var wnd = new Array(1 << windowSize);
		    wnd[0] = new BN(1).toRed(this);
		    wnd[1] = a;
		    for (var i = 2; i < wnd.length; i++) {
		      wnd[i] = this.mul(wnd[i - 1], a);
		    }

		    var res = wnd[0];
		    var current = 0;
		    var currentLen = 0;
		    var start = num.bitLength() % 26;
		    if (start === 0) {
		      start = 26;
		    }

		    for (i = num.length - 1; i >= 0; i--) {
		      var word = num.words[i];
		      for (var j = start - 1; j >= 0; j--) {
		        var bit = (word >> j) & 1;
		        if (res !== wnd[0]) {
		          res = this.sqr(res);
		        }

		        if (bit === 0 && current === 0) {
		          currentLen = 0;
		          continue;
		        }

		        current <<= 1;
		        current |= bit;
		        currentLen++;
		        if (currentLen !== windowSize && (i !== 0 || j !== 0)) continue;

		        res = this.mul(res, wnd[current]);
		        currentLen = 0;
		        current = 0;
		      }
		      start = 26;
		    }

		    return res;
		  };

		  Red.prototype.convertTo = function convertTo (num) {
		    var r = num.umod(this.m);

		    return r === num ? r.clone() : r;
		  };

		  Red.prototype.convertFrom = function convertFrom (num) {
		    var res = num.clone();
		    res.red = null;
		    return res;
		  };

		  //
		  // Montgomery method engine
		  //

		  BN.mont = function mont (num) {
		    return new Mont(num);
		  };

		  function Mont (m) {
		    Red.call(this, m);

		    this.shift = this.m.bitLength();
		    if (this.shift % 26 !== 0) {
		      this.shift += 26 - (this.shift % 26);
		    }

		    this.r = new BN(1).iushln(this.shift);
		    this.r2 = this.imod(this.r.sqr());
		    this.rinv = this.r._invmp(this.m);

		    this.minv = this.rinv.mul(this.r).isubn(1).div(this.m);
		    this.minv = this.minv.umod(this.r);
		    this.minv = this.r.sub(this.minv);
		  }
		  inherits(Mont, Red);

		  Mont.prototype.convertTo = function convertTo (num) {
		    return this.imod(num.ushln(this.shift));
		  };

		  Mont.prototype.convertFrom = function convertFrom (num) {
		    var r = this.imod(num.mul(this.rinv));
		    r.red = null;
		    return r;
		  };

		  Mont.prototype.imul = function imul (a, b) {
		    if (a.isZero() || b.isZero()) {
		      a.words[0] = 0;
		      a.length = 1;
		      return a;
		    }

		    var t = a.imul(b);
		    var c = t.maskn(this.shift).mul(this.minv).imaskn(this.shift).mul(this.m);
		    var u = t.isub(c).iushrn(this.shift);
		    var res = u;

		    if (u.cmp(this.m) >= 0) {
		      res = u.isub(this.m);
		    } else if (u.cmpn(0) < 0) {
		      res = u.iadd(this.m);
		    }

		    return res._forceRed(this);
		  };

		  Mont.prototype.mul = function mul (a, b) {
		    if (a.isZero() || b.isZero()) return new BN(0)._forceRed(this);

		    var t = a.mul(b);
		    var c = t.maskn(this.shift).mul(this.minv).imaskn(this.shift).mul(this.m);
		    var u = t.isub(c).iushrn(this.shift);
		    var res = u;
		    if (u.cmp(this.m) >= 0) {
		      res = u.isub(this.m);
		    } else if (u.cmpn(0) < 0) {
		      res = u.iadd(this.m);
		    }

		    return res._forceRed(this);
		  };

		  Mont.prototype.invm = function invm (a) {
		    // (AR)^-1 * R^2 = (A^-1 * R^-1) * R^2 = A^-1 * R
		    var res = this.imod(a._invmp(this.m).mul(this.r2));
		    return res._forceRed(this);
		  };
		})(module, bn); 
	} (bn$1));
	return bn$1.exports;
}

var bnExports = requireBn();

const DEFAULT_COMMITMENT = "finalized";
const DEFAULT_FINALITY = "finalized";
const calculateWithSlippageBuy = (amount, basisPoints) => {
    return amount + (amount * basisPoints) / 10000n;
};
function calculateWithSlippageSell(amount, slippageBasisPoints = 500n) {
    // Actually use the slippage basis points for calculation
    const reduction = Math.max(1, Number((amount * slippageBasisPoints) / 10000n));
    return amount - BigInt(reduction);
}
async function sendTx(connection, tx, payer, signers, priorityFees, commitment = DEFAULT_COMMITMENT, finality = DEFAULT_FINALITY) {
    let newTx = new Transaction();
    if (priorityFees) {
        const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
            units: priorityFees.unitLimit,
        });
        const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFees.unitPrice,
        });
        newTx.add(modifyComputeUnits);
        newTx.add(addPriorityFee);
    }
    newTx.add(tx);
    let versionedTx = await buildVersionedTx(connection, payer, newTx, commitment);
    versionedTx.sign(signers);
    try {
        const sig = await connection.sendTransaction(versionedTx, {
            skipPreflight: false,
        });
        console.log("sig:", `https://solscan.io/tx/${sig}`);
        let txResult = await getTxDetails(connection, sig, commitment, finality);
        if (!txResult) {
            return {
                success: false,
                error: "Transaction failed",
            };
        }
        return {
            success: true,
            signature: sig,
            results: txResult,
        };
    }
    catch (e) {
        if (e instanceof SendTransactionError) {
            let ste = e;
            console.log("SendTransactionError" + await ste.getLogs(connection));
        }
        else {
            console.error(e);
        }
        return {
            error: e,
            success: false,
        };
    }
}
const buildVersionedTx = async (connection, payer, tx, commitment = DEFAULT_COMMITMENT) => {
    const blockHash = (await connection.getLatestBlockhash(commitment))
        .blockhash;
    let messageV0 = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockHash,
        instructions: tx.instructions,
    }).compileToV0Message();
    return new VersionedTransaction(messageV0);
};
const getTxDetails = async (connection, sig, commitment = DEFAULT_COMMITMENT, finality = DEFAULT_FINALITY) => {
    const latestBlockHash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
        signature: sig,
    }, commitment);
    return connection.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: finality,
    });
};

var address = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
var metadata = {
	name: "pump",
	version: "0.1.0",
	spec: "0.1.0",
	description: "Created with Anchor"
};
var instructions = [
	{
		name: "buy",
		docs: [
			"Buys tokens from a bonding curve."
		],
		discriminator: [
			102,
			6,
			61,
			18,
			1,
			218,
			235,
			234
		],
		accounts: [
			{
				name: "global",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								103,
								108,
								111,
								98,
								97,
								108
							]
						}
					]
				}
			},
			{
				name: "fee_recipient",
				writable: true
			},
			{
				name: "mint"
			},
			{
				name: "bonding_curve",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								98,
								111,
								110,
								100,
								105,
								110,
								103,
								45,
								99,
								117,
								114,
								118,
								101
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					]
				}
			},
			{
				name: "associated_bonding_curve",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "account",
							path: "bonding_curve"
						},
						{
							kind: "const",
							value: [
								6,
								221,
								246,
								225,
								215,
								101,
								161,
								147,
								217,
								203,
								225,
								70,
								206,
								235,
								121,
								172,
								28,
								180,
								133,
								237,
								95,
								91,
								55,
								145,
								58,
								140,
								245,
								133,
								126,
								255,
								0,
								169
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					],
					program: {
						kind: "const",
						value: [
							140,
							151,
							37,
							143,
							78,
							36,
							137,
							241,
							187,
							61,
							16,
							41,
							20,
							142,
							13,
							131,
							11,
							90,
							19,
							153,
							218,
							255,
							16,
							132,
							4,
							142,
							123,
							216,
							219,
							233,
							248,
							89
						]
					}
				}
			},
			{
				name: "associated_user",
				writable: true
			},
			{
				name: "user",
				writable: true,
				signer: true
			},
			{
				name: "system_program",
				address: "11111111111111111111111111111111"
			},
			{
				name: "token_program",
				address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
			},
			{
				name: "creator_vault",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								99,
								114,
								101,
								97,
								116,
								111,
								114,
								45,
								118,
								97,
								117,
								108,
								116
							]
						},
						{
							kind: "account",
							path: "bonding_curve.creator",
							account: "BondingCurve"
						}
					]
				}
			},
			{
				name: "event_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								95,
								95,
								101,
								118,
								101,
								110,
								116,
								95,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					]
				}
			},
			{
				name: "program"
			}
		],
		args: [
			{
				name: "amount",
				type: "u64"
			},
			{
				name: "max_sol_cost",
				type: "u64"
			}
		]
	},
	{
		name: "collect_creator_fee",
		docs: [
			"Collects creator_fee from creator_vault to the coin creator account"
		],
		discriminator: [
			20,
			22,
			86,
			123,
			198,
			28,
			219,
			132
		],
		accounts: [
			{
				name: "creator",
				writable: true,
				signer: true
			},
			{
				name: "creator_vault",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								99,
								114,
								101,
								97,
								116,
								111,
								114,
								45,
								118,
								97,
								117,
								108,
								116
							]
						},
						{
							kind: "account",
							path: "creator"
						}
					]
				}
			},
			{
				name: "system_program",
				address: "11111111111111111111111111111111"
			},
			{
				name: "event_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								95,
								95,
								101,
								118,
								101,
								110,
								116,
								95,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					]
				}
			},
			{
				name: "program"
			}
		],
		args: [
		]
	},
	{
		name: "create",
		docs: [
			"Creates a new coin and bonding curve."
		],
		discriminator: [
			24,
			30,
			200,
			40,
			5,
			28,
			7,
			119
		],
		accounts: [
			{
				name: "mint",
				writable: true,
				signer: true
			},
			{
				name: "mint_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								109,
								105,
								110,
								116,
								45,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					]
				}
			},
			{
				name: "bonding_curve",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								98,
								111,
								110,
								100,
								105,
								110,
								103,
								45,
								99,
								117,
								114,
								118,
								101
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					]
				}
			},
			{
				name: "associated_bonding_curve",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "account",
							path: "bonding_curve"
						},
						{
							kind: "const",
							value: [
								6,
								221,
								246,
								225,
								215,
								101,
								161,
								147,
								217,
								203,
								225,
								70,
								206,
								235,
								121,
								172,
								28,
								180,
								133,
								237,
								95,
								91,
								55,
								145,
								58,
								140,
								245,
								133,
								126,
								255,
								0,
								169
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					],
					program: {
						kind: "const",
						value: [
							140,
							151,
							37,
							143,
							78,
							36,
							137,
							241,
							187,
							61,
							16,
							41,
							20,
							142,
							13,
							131,
							11,
							90,
							19,
							153,
							218,
							255,
							16,
							132,
							4,
							142,
							123,
							216,
							219,
							233,
							248,
							89
						]
					}
				}
			},
			{
				name: "global",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								103,
								108,
								111,
								98,
								97,
								108
							]
						}
					]
				}
			},
			{
				name: "mpl_token_metadata",
				address: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
			},
			{
				name: "metadata",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								109,
								101,
								116,
								97,
								100,
								97,
								116,
								97
							]
						},
						{
							kind: "const",
							value: [
								11,
								112,
								101,
								177,
								227,
								209,
								124,
								69,
								56,
								157,
								82,
								127,
								107,
								4,
								195,
								205,
								88,
								184,
								108,
								115,
								26,
								160,
								253,
								181,
								73,
								182,
								209,
								188,
								3,
								248,
								41,
								70
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					],
					program: {
						kind: "account",
						path: "mpl_token_metadata"
					}
				}
			},
			{
				name: "user",
				writable: true,
				signer: true
			},
			{
				name: "system_program",
				address: "11111111111111111111111111111111"
			},
			{
				name: "token_program",
				address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
			},
			{
				name: "associated_token_program",
				address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
			},
			{
				name: "rent",
				address: "SysvarRent111111111111111111111111111111111"
			},
			{
				name: "event_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								95,
								95,
								101,
								118,
								101,
								110,
								116,
								95,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					]
				}
			},
			{
				name: "program"
			}
		],
		args: [
			{
				name: "name",
				type: "string"
			},
			{
				name: "symbol",
				type: "string"
			},
			{
				name: "uri",
				type: "string"
			},
			{
				name: "creator",
				type: "pubkey"
			}
		]
	},
	{
		name: "extend_account",
		docs: [
			"Extends the size of program-owned accounts"
		],
		discriminator: [
			234,
			102,
			194,
			203,
			150,
			72,
			62,
			229
		],
		accounts: [
			{
				name: "account",
				writable: true
			},
			{
				name: "user",
				signer: true
			},
			{
				name: "system_program",
				address: "11111111111111111111111111111111"
			},
			{
				name: "event_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								95,
								95,
								101,
								118,
								101,
								110,
								116,
								95,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					]
				}
			},
			{
				name: "program"
			}
		],
		args: [
		]
	},
	{
		name: "initialize",
		docs: [
			"Creates the global state."
		],
		discriminator: [
			175,
			175,
			109,
			31,
			13,
			152,
			155,
			237
		],
		accounts: [
			{
				name: "global",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								103,
								108,
								111,
								98,
								97,
								108
							]
						}
					]
				}
			},
			{
				name: "user",
				writable: true,
				signer: true
			},
			{
				name: "system_program",
				address: "11111111111111111111111111111111"
			}
		],
		args: [
		]
	},
	{
		name: "migrate",
		docs: [
			"Migrates liquidity to pump_amm if the bonding curve is complete"
		],
		discriminator: [
			155,
			234,
			231,
			146,
			236,
			158,
			162,
			30
		],
		accounts: [
			{
				name: "global",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								103,
								108,
								111,
								98,
								97,
								108
							]
						}
					]
				}
			},
			{
				name: "withdraw_authority",
				writable: true,
				relations: [
					"global"
				]
			},
			{
				name: "mint"
			},
			{
				name: "bonding_curve",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								98,
								111,
								110,
								100,
								105,
								110,
								103,
								45,
								99,
								117,
								114,
								118,
								101
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					]
				}
			},
			{
				name: "associated_bonding_curve",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "account",
							path: "bonding_curve"
						},
						{
							kind: "const",
							value: [
								6,
								221,
								246,
								225,
								215,
								101,
								161,
								147,
								217,
								203,
								225,
								70,
								206,
								235,
								121,
								172,
								28,
								180,
								133,
								237,
								95,
								91,
								55,
								145,
								58,
								140,
								245,
								133,
								126,
								255,
								0,
								169
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					],
					program: {
						kind: "const",
						value: [
							140,
							151,
							37,
							143,
							78,
							36,
							137,
							241,
							187,
							61,
							16,
							41,
							20,
							142,
							13,
							131,
							11,
							90,
							19,
							153,
							218,
							255,
							16,
							132,
							4,
							142,
							123,
							216,
							219,
							233,
							248,
							89
						]
					}
				}
			},
			{
				name: "user",
				signer: true
			},
			{
				name: "system_program",
				address: "11111111111111111111111111111111"
			},
			{
				name: "token_program",
				address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
			},
			{
				name: "pump_amm",
				address: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
			},
			{
				name: "pool",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								112,
								111,
								111,
								108
							]
						},
						{
							kind: "const",
							value: [
								0,
								0
							]
						},
						{
							kind: "account",
							path: "pool_authority"
						},
						{
							kind: "account",
							path: "mint"
						},
						{
							kind: "account",
							path: "wsol_mint"
						}
					],
					program: {
						kind: "account",
						path: "pump_amm"
					}
				}
			},
			{
				name: "pool_authority",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								112,
								111,
								111,
								108,
								45,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					]
				}
			},
			{
				name: "pool_authority_mint_account",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "account",
							path: "pool_authority"
						},
						{
							kind: "account",
							path: "token_program"
						},
						{
							kind: "account",
							path: "mint"
						}
					],
					program: {
						kind: "account",
						path: "associated_token_program"
					}
				}
			},
			{
				name: "pool_authority_wsol_account",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "account",
							path: "pool_authority"
						},
						{
							kind: "account",
							path: "token_program"
						},
						{
							kind: "account",
							path: "wsol_mint"
						}
					],
					program: {
						kind: "account",
						path: "associated_token_program"
					}
				}
			},
			{
				name: "amm_global_config",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								103,
								108,
								111,
								98,
								97,
								108,
								95,
								99,
								111,
								110,
								102,
								105,
								103
							]
						}
					],
					program: {
						kind: "account",
						path: "pump_amm"
					}
				}
			},
			{
				name: "wsol_mint",
				address: "So11111111111111111111111111111111111111112"
			},
			{
				name: "lp_mint",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								112,
								111,
								111,
								108,
								95,
								108,
								112,
								95,
								109,
								105,
								110,
								116
							]
						},
						{
							kind: "account",
							path: "pool"
						}
					],
					program: {
						kind: "account",
						path: "pump_amm"
					}
				}
			},
			{
				name: "user_pool_token_account",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "account",
							path: "pool_authority"
						},
						{
							kind: "account",
							path: "token_2022_program"
						},
						{
							kind: "account",
							path: "lp_mint"
						}
					],
					program: {
						kind: "account",
						path: "associated_token_program"
					}
				}
			},
			{
				name: "pool_base_token_account",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "account",
							path: "pool"
						},
						{
							kind: "account",
							path: "token_program"
						},
						{
							kind: "account",
							path: "mint"
						}
					],
					program: {
						kind: "account",
						path: "associated_token_program"
					}
				}
			},
			{
				name: "pool_quote_token_account",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "account",
							path: "pool"
						},
						{
							kind: "account",
							path: "token_program"
						},
						{
							kind: "account",
							path: "wsol_mint"
						}
					],
					program: {
						kind: "account",
						path: "associated_token_program"
					}
				}
			},
			{
				name: "token_2022_program",
				address: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
			},
			{
				name: "associated_token_program",
				address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
			},
			{
				name: "pump_amm_event_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								95,
								95,
								101,
								118,
								101,
								110,
								116,
								95,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					],
					program: {
						kind: "account",
						path: "pump_amm"
					}
				}
			},
			{
				name: "event_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								95,
								95,
								101,
								118,
								101,
								110,
								116,
								95,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					]
				}
			},
			{
				name: "program"
			}
		],
		args: [
		]
	},
	{
		name: "sell",
		docs: [
			"Sells tokens into a bonding curve."
		],
		discriminator: [
			51,
			230,
			133,
			164,
			1,
			127,
			131,
			173
		],
		accounts: [
			{
				name: "global",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								103,
								108,
								111,
								98,
								97,
								108
							]
						}
					]
				}
			},
			{
				name: "fee_recipient",
				writable: true
			},
			{
				name: "mint"
			},
			{
				name: "bonding_curve",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								98,
								111,
								110,
								100,
								105,
								110,
								103,
								45,
								99,
								117,
								114,
								118,
								101
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					]
				}
			},
			{
				name: "associated_bonding_curve",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "account",
							path: "bonding_curve"
						},
						{
							kind: "const",
							value: [
								6,
								221,
								246,
								225,
								215,
								101,
								161,
								147,
								217,
								203,
								225,
								70,
								206,
								235,
								121,
								172,
								28,
								180,
								133,
								237,
								95,
								91,
								55,
								145,
								58,
								140,
								245,
								133,
								126,
								255,
								0,
								169
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					],
					program: {
						kind: "const",
						value: [
							140,
							151,
							37,
							143,
							78,
							36,
							137,
							241,
							187,
							61,
							16,
							41,
							20,
							142,
							13,
							131,
							11,
							90,
							19,
							153,
							218,
							255,
							16,
							132,
							4,
							142,
							123,
							216,
							219,
							233,
							248,
							89
						]
					}
				}
			},
			{
				name: "associated_user",
				writable: true
			},
			{
				name: "user",
				writable: true,
				signer: true
			},
			{
				name: "system_program",
				address: "11111111111111111111111111111111"
			},
			{
				name: "creator_vault",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								99,
								114,
								101,
								97,
								116,
								111,
								114,
								45,
								118,
								97,
								117,
								108,
								116
							]
						},
						{
							kind: "account",
							path: "bonding_curve.creator",
							account: "BondingCurve"
						}
					]
				}
			},
			{
				name: "token_program",
				address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
			},
			{
				name: "event_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								95,
								95,
								101,
								118,
								101,
								110,
								116,
								95,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					]
				}
			},
			{
				name: "program"
			}
		],
		args: [
			{
				name: "amount",
				type: "u64"
			},
			{
				name: "min_sol_output",
				type: "u64"
			}
		]
	},
	{
		name: "set_creator",
		docs: [
			"Allows Global::set_creator_authority to set the bonding curve creator from Metaplex metadata or input argument"
		],
		discriminator: [
			254,
			148,
			255,
			112,
			207,
			142,
			170,
			165
		],
		accounts: [
			{
				name: "set_creator_authority",
				signer: true,
				relations: [
					"global"
				]
			},
			{
				name: "global",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								103,
								108,
								111,
								98,
								97,
								108
							]
						}
					]
				}
			},
			{
				name: "mint"
			},
			{
				name: "metadata",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								109,
								101,
								116,
								97,
								100,
								97,
								116,
								97
							]
						},
						{
							kind: "const",
							value: [
								11,
								112,
								101,
								177,
								227,
								209,
								124,
								69,
								56,
								157,
								82,
								127,
								107,
								4,
								195,
								205,
								88,
								184,
								108,
								115,
								26,
								160,
								253,
								181,
								73,
								182,
								209,
								188,
								3,
								248,
								41,
								70
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					],
					program: {
						kind: "const",
						value: [
							11,
							112,
							101,
							177,
							227,
							209,
							124,
							69,
							56,
							157,
							82,
							127,
							107,
							4,
							195,
							205,
							88,
							184,
							108,
							115,
							26,
							160,
							253,
							181,
							73,
							182,
							209,
							188,
							3,
							248,
							41,
							70
						]
					}
				}
			},
			{
				name: "bonding_curve",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								98,
								111,
								110,
								100,
								105,
								110,
								103,
								45,
								99,
								117,
								114,
								118,
								101
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					]
				}
			},
			{
				name: "event_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								95,
								95,
								101,
								118,
								101,
								110,
								116,
								95,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					]
				}
			},
			{
				name: "program"
			}
		],
		args: [
			{
				name: "creator",
				type: "pubkey"
			}
		]
	},
	{
		name: "set_metaplex_creator",
		docs: [
			"Syncs the bonding curve creator with the Metaplex metadata creator if it exists"
		],
		discriminator: [
			138,
			96,
			174,
			217,
			48,
			85,
			197,
			246
		],
		accounts: [
			{
				name: "mint"
			},
			{
				name: "metadata",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								109,
								101,
								116,
								97,
								100,
								97,
								116,
								97
							]
						},
						{
							kind: "const",
							value: [
								11,
								112,
								101,
								177,
								227,
								209,
								124,
								69,
								56,
								157,
								82,
								127,
								107,
								4,
								195,
								205,
								88,
								184,
								108,
								115,
								26,
								160,
								253,
								181,
								73,
								182,
								209,
								188,
								3,
								248,
								41,
								70
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					],
					program: {
						kind: "const",
						value: [
							11,
							112,
							101,
							177,
							227,
							209,
							124,
							69,
							56,
							157,
							82,
							127,
							107,
							4,
							195,
							205,
							88,
							184,
							108,
							115,
							26,
							160,
							253,
							181,
							73,
							182,
							209,
							188,
							3,
							248,
							41,
							70
						]
					}
				}
			},
			{
				name: "bonding_curve",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								98,
								111,
								110,
								100,
								105,
								110,
								103,
								45,
								99,
								117,
								114,
								118,
								101
							]
						},
						{
							kind: "account",
							path: "mint"
						}
					]
				}
			},
			{
				name: "event_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								95,
								95,
								101,
								118,
								101,
								110,
								116,
								95,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					]
				}
			},
			{
				name: "program"
			}
		],
		args: [
		]
	},
	{
		name: "set_params",
		docs: [
			"Sets the global state parameters."
		],
		discriminator: [
			27,
			234,
			178,
			52,
			147,
			2,
			187,
			141
		],
		accounts: [
			{
				name: "global",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								103,
								108,
								111,
								98,
								97,
								108
							]
						}
					]
				}
			},
			{
				name: "authority",
				writable: true,
				signer: true,
				relations: [
					"global"
				]
			},
			{
				name: "event_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								95,
								95,
								101,
								118,
								101,
								110,
								116,
								95,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					]
				}
			},
			{
				name: "program"
			}
		],
		args: [
			{
				name: "initial_virtual_token_reserves",
				type: "u64"
			},
			{
				name: "initial_virtual_sol_reserves",
				type: "u64"
			},
			{
				name: "initial_real_token_reserves",
				type: "u64"
			},
			{
				name: "token_total_supply",
				type: "u64"
			},
			{
				name: "fee_basis_points",
				type: "u64"
			},
			{
				name: "withdraw_authority",
				type: "pubkey"
			},
			{
				name: "enable_migrate",
				type: "bool"
			},
			{
				name: "pool_migration_fee",
				type: "u64"
			},
			{
				name: "creator_fee_basis_points",
				type: "u64"
			},
			{
				name: "set_creator_authority",
				type: "pubkey"
			}
		]
	},
	{
		name: "update_global_authority",
		discriminator: [
			227,
			181,
			74,
			196,
			208,
			21,
			97,
			213
		],
		accounts: [
			{
				name: "global",
				writable: true,
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								103,
								108,
								111,
								98,
								97,
								108
							]
						}
					]
				}
			},
			{
				name: "authority",
				signer: true,
				relations: [
					"global"
				]
			},
			{
				name: "new_authority"
			},
			{
				name: "event_authority",
				pda: {
					seeds: [
						{
							kind: "const",
							value: [
								95,
								95,
								101,
								118,
								101,
								110,
								116,
								95,
								97,
								117,
								116,
								104,
								111,
								114,
								105,
								116,
								121
							]
						}
					]
				}
			},
			{
				name: "program"
			}
		],
		args: [
		]
	}
];
var accounts = [
	{
		name: "BondingCurve",
		discriminator: [
			23,
			183,
			248,
			55,
			96,
			216,
			172,
			96
		]
	},
	{
		name: "Global",
		discriminator: [
			167,
			232,
			232,
			177,
			200,
			108,
			114,
			127
		]
	}
];
var events = [
	{
		name: "CollectCreatorFeeEvent",
		discriminator: [
			122,
			2,
			127,
			1,
			14,
			191,
			12,
			175
		]
	},
	{
		name: "CompleteEvent",
		discriminator: [
			95,
			114,
			97,
			156,
			212,
			46,
			152,
			8
		]
	},
	{
		name: "CompletePumpAmmMigrationEvent",
		discriminator: [
			189,
			233,
			93,
			185,
			92,
			148,
			234,
			148
		]
	},
	{
		name: "CreateEvent",
		discriminator: [
			27,
			114,
			169,
			77,
			222,
			235,
			99,
			118
		]
	},
	{
		name: "ExtendAccountEvent",
		discriminator: [
			97,
			97,
			215,
			144,
			93,
			146,
			22,
			124
		]
	},
	{
		name: "SetCreatorEvent",
		discriminator: [
			237,
			52,
			123,
			37,
			245,
			251,
			72,
			210
		]
	},
	{
		name: "SetMetaplexCreatorEvent",
		discriminator: [
			142,
			203,
			6,
			32,
			127,
			105,
			191,
			162
		]
	},
	{
		name: "SetParamsEvent",
		discriminator: [
			223,
			195,
			159,
			246,
			62,
			48,
			143,
			131
		]
	},
	{
		name: "TradeEvent",
		discriminator: [
			189,
			219,
			127,
			211,
			78,
			230,
			97,
			238
		]
	},
	{
		name: "UpdateGlobalAuthorityEvent",
		discriminator: [
			182,
			195,
			137,
			42,
			35,
			206,
			207,
			247
		]
	}
];
var errors = [
	{
		code: 6000,
		name: "NotAuthorized",
		msg: "The given account is not authorized to execute this instruction."
	},
	{
		code: 6001,
		name: "AlreadyInitialized",
		msg: "The program is already initialized."
	},
	{
		code: 6002,
		name: "TooMuchSolRequired",
		msg: "slippage: Too much SOL required to buy the given amount of tokens."
	},
	{
		code: 6003,
		name: "TooLittleSolReceived",
		msg: "slippage: Too little SOL received to sell the given amount of tokens."
	},
	{
		code: 6004,
		name: "MintDoesNotMatchBondingCurve",
		msg: "The mint does not match the bonding curve."
	},
	{
		code: 6005,
		name: "BondingCurveComplete",
		msg: "The bonding curve has completed and liquidity migrated to raydium."
	},
	{
		code: 6006,
		name: "BondingCurveNotComplete",
		msg: "The bonding curve has not completed."
	},
	{
		code: 6007,
		name: "NotInitialized",
		msg: "The program is not initialized."
	},
	{
		code: 6008,
		name: "WithdrawTooFrequent",
		msg: "Withdraw too frequent"
	},
	{
		code: 6009,
		name: "NewSizeShouldBeGreaterThanCurrentSize",
		msg: "new_size should be > current_size"
	},
	{
		code: 6010,
		name: "AccountTypeNotSupported",
		msg: "Account type not supported"
	},
	{
		code: 6011,
		name: "InitialRealTokenReservesShouldBeLessThanTokenTotalSupply",
		msg: "initial_real_token_reserves should be less than token_total_supply"
	},
	{
		code: 6012,
		name: "InitialVirtualTokenReservesShouldBeGreaterThanInitialRealTokenReserves",
		msg: "initial_virtual_token_reserves should be greater than initial_real_token_reserves"
	},
	{
		code: 6013,
		name: "FeeBasisPointsGreaterThanMaximum",
		msg: "fee_basis_points greater than maximum"
	},
	{
		code: 6014,
		name: "AllZerosWithdrawAuthority",
		msg: "Withdraw authority cannot be set to System Program ID"
	},
	{
		code: 6015,
		name: "PoolMigrationFeeShouldBeLessThanFinalRealSolReserves",
		msg: "pool_migration_fee should be less than final_real_sol_reserves"
	},
	{
		code: 6016,
		name: "PoolMigrationFeeShouldBeGreaterThanCreatorFeePlusMaxMigrateFees",
		msg: "pool_migration_fee should be greater than creator_fee + MAX_MIGRATE_FEES"
	},
	{
		code: 6017,
		name: "DisabledWithdraw",
		msg: "Migrate instruction is disabled"
	},
	{
		code: 6018,
		name: "DisabledMigrate",
		msg: "Migrate instruction is disabled"
	},
	{
		code: 6019,
		name: "InvalidCreator",
		msg: "Invalid creator pubkey"
	},
	{
		code: 6020,
		name: "BuyZeroAmount",
		msg: "Buy zero amount"
	},
	{
		code: 6021,
		name: "NotEnoughTokensToBuy",
		msg: "Not enough tokens to buy"
	},
	{
		code: 6022,
		name: "SellZeroAmount",
		msg: "Sell zero amount"
	},
	{
		code: 6023,
		name: "NotEnoughTokensToSell",
		msg: "Not enough tokens to sell"
	},
	{
		code: 6024,
		name: "Overflow",
		msg: "Overflow"
	},
	{
		code: 6025,
		name: "Truncation",
		msg: "Truncation"
	},
	{
		code: 6026,
		name: "DivisionByZero",
		msg: "Division by zero"
	},
	{
		code: 6027,
		name: "NotEnoughRemainingAccounts",
		msg: "Not enough remaining accounts"
	},
	{
		code: 6028,
		name: "AllFeeRecipientsShouldBeNonZero",
		msg: "All fee recipients should be non-zero"
	},
	{
		code: 6029,
		name: "UnsortedNotUniqueFeeRecipients",
		msg: "Unsorted or not unique fee recipients"
	},
	{
		code: 6030,
		name: "CreatorShouldNotBeZero",
		msg: "Creator should not be zero"
	}
];
var types = [
	{
		name: "BondingCurve",
		type: {
			kind: "struct",
			fields: [
				{
					name: "virtual_token_reserves",
					type: "u64"
				},
				{
					name: "virtual_sol_reserves",
					type: "u64"
				},
				{
					name: "real_token_reserves",
					type: "u64"
				},
				{
					name: "real_sol_reserves",
					type: "u64"
				},
				{
					name: "token_total_supply",
					type: "u64"
				},
				{
					name: "complete",
					type: "bool"
				},
				{
					name: "creator",
					type: "pubkey"
				}
			]
		}
	},
	{
		name: "CollectCreatorFeeEvent",
		type: {
			kind: "struct",
			fields: [
				{
					name: "timestamp",
					type: "i64"
				},
				{
					name: "creator",
					type: "pubkey"
				},
				{
					name: "creator_fee",
					type: "u64"
				}
			]
		}
	},
	{
		name: "CompleteEvent",
		type: {
			kind: "struct",
			fields: [
				{
					name: "user",
					type: "pubkey"
				},
				{
					name: "mint",
					type: "pubkey"
				},
				{
					name: "bonding_curve",
					type: "pubkey"
				},
				{
					name: "timestamp",
					type: "i64"
				}
			]
		}
	},
	{
		name: "CompletePumpAmmMigrationEvent",
		type: {
			kind: "struct",
			fields: [
				{
					name: "user",
					type: "pubkey"
				},
				{
					name: "mint",
					type: "pubkey"
				},
				{
					name: "mint_amount",
					type: "u64"
				},
				{
					name: "sol_amount",
					type: "u64"
				},
				{
					name: "pool_migration_fee",
					type: "u64"
				},
				{
					name: "bonding_curve",
					type: "pubkey"
				},
				{
					name: "timestamp",
					type: "i64"
				},
				{
					name: "pool",
					type: "pubkey"
				}
			]
		}
	},
	{
		name: "CreateEvent",
		type: {
			kind: "struct",
			fields: [
				{
					name: "name",
					type: "string"
				},
				{
					name: "symbol",
					type: "string"
				},
				{
					name: "uri",
					type: "string"
				},
				{
					name: "mint",
					type: "pubkey"
				},
				{
					name: "bonding_curve",
					type: "pubkey"
				},
				{
					name: "user",
					type: "pubkey"
				},
				{
					name: "creator",
					type: "pubkey"
				},
				{
					name: "timestamp",
					type: "i64"
				},
				{
					name: "virtual_token_reserves",
					type: "u64"
				},
				{
					name: "virtual_sol_reserves",
					type: "u64"
				},
				{
					name: "real_token_reserves",
					type: "u64"
				},
				{
					name: "token_total_supply",
					type: "u64"
				}
			]
		}
	},
	{
		name: "ExtendAccountEvent",
		type: {
			kind: "struct",
			fields: [
				{
					name: "account",
					type: "pubkey"
				},
				{
					name: "user",
					type: "pubkey"
				},
				{
					name: "current_size",
					type: "u64"
				},
				{
					name: "new_size",
					type: "u64"
				},
				{
					name: "timestamp",
					type: "i64"
				}
			]
		}
	},
	{
		name: "Global",
		type: {
			kind: "struct",
			fields: [
				{
					name: "initialized",
					docs: [
						"Unused"
					],
					type: "bool"
				},
				{
					name: "authority",
					type: "pubkey"
				},
				{
					name: "fee_recipient",
					type: "pubkey"
				},
				{
					name: "initial_virtual_token_reserves",
					type: "u64"
				},
				{
					name: "initial_virtual_sol_reserves",
					type: "u64"
				},
				{
					name: "initial_real_token_reserves",
					type: "u64"
				},
				{
					name: "token_total_supply",
					type: "u64"
				},
				{
					name: "fee_basis_points",
					type: "u64"
				},
				{
					name: "withdraw_authority",
					type: "pubkey"
				},
				{
					name: "enable_migrate",
					docs: [
						"Unused"
					],
					type: "bool"
				},
				{
					name: "pool_migration_fee",
					type: "u64"
				},
				{
					name: "creator_fee_basis_points",
					type: "u64"
				},
				{
					name: "fee_recipients",
					type: {
						array: [
							"pubkey",
							7
						]
					}
				},
				{
					name: "set_creator_authority",
					type: "pubkey"
				}
			]
		}
	},
	{
		name: "SetCreatorEvent",
		type: {
			kind: "struct",
			fields: [
				{
					name: "timestamp",
					type: "i64"
				},
				{
					name: "mint",
					type: "pubkey"
				},
				{
					name: "bonding_curve",
					type: "pubkey"
				},
				{
					name: "creator",
					type: "pubkey"
				}
			]
		}
	},
	{
		name: "SetMetaplexCreatorEvent",
		type: {
			kind: "struct",
			fields: [
				{
					name: "timestamp",
					type: "i64"
				},
				{
					name: "mint",
					type: "pubkey"
				},
				{
					name: "bonding_curve",
					type: "pubkey"
				},
				{
					name: "metadata",
					type: "pubkey"
				},
				{
					name: "creator",
					type: "pubkey"
				}
			]
		}
	},
	{
		name: "SetParamsEvent",
		type: {
			kind: "struct",
			fields: [
				{
					name: "initial_virtual_token_reserves",
					type: "u64"
				},
				{
					name: "initial_virtual_sol_reserves",
					type: "u64"
				},
				{
					name: "initial_real_token_reserves",
					type: "u64"
				},
				{
					name: "final_real_sol_reserves",
					type: "u64"
				},
				{
					name: "token_total_supply",
					type: "u64"
				},
				{
					name: "fee_basis_points",
					type: "u64"
				},
				{
					name: "withdraw_authority",
					type: "pubkey"
				},
				{
					name: "enable_migrate",
					type: "bool"
				},
				{
					name: "pool_migration_fee",
					type: "u64"
				},
				{
					name: "creator_fee_basis_points",
					type: "u64"
				},
				{
					name: "fee_recipients",
					type: {
						array: [
							"pubkey",
							8
						]
					}
				},
				{
					name: "timestamp",
					type: "i64"
				},
				{
					name: "set_creator_authority",
					type: "pubkey"
				}
			]
		}
	},
	{
		name: "TradeEvent",
		type: {
			kind: "struct",
			fields: [
				{
					name: "mint",
					type: "pubkey"
				},
				{
					name: "sol_amount",
					type: "u64"
				},
				{
					name: "token_amount",
					type: "u64"
				},
				{
					name: "is_buy",
					type: "bool"
				},
				{
					name: "user",
					type: "pubkey"
				},
				{
					name: "timestamp",
					type: "i64"
				},
				{
					name: "virtual_sol_reserves",
					type: "u64"
				},
				{
					name: "virtual_token_reserves",
					type: "u64"
				},
				{
					name: "real_sol_reserves",
					type: "u64"
				},
				{
					name: "real_token_reserves",
					type: "u64"
				},
				{
					name: "fee_recipient",
					type: "pubkey"
				},
				{
					name: "fee_basis_points",
					type: "u64"
				},
				{
					name: "fee",
					type: "u64"
				},
				{
					name: "creator",
					type: "pubkey"
				},
				{
					name: "creator_fee_basis_points",
					type: "u64"
				},
				{
					name: "creator_fee",
					type: "u64"
				}
			]
		}
	},
	{
		name: "UpdateGlobalAuthorityEvent",
		type: {
			kind: "struct",
			fields: [
				{
					name: "global",
					type: "pubkey"
				},
				{
					name: "authority",
					type: "pubkey"
				},
				{
					name: "new_authority",
					type: "pubkey"
				},
				{
					name: "timestamp",
					type: "i64"
				}
			]
		}
	}
];
var IDL = {
	address: address,
	metadata: metadata,
	instructions: instructions,
	accounts: accounts,
	events: events,
	errors: errors,
	types: types
};

// SDK Constants
const MPL_TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const GLOBAL_ACCOUNT_SEED = "global";
const MINT_AUTHORITY_SEED = "mint-authority";
const BONDING_CURVE_SEED = "bonding-curve";
const METADATA_SEED = "metadata";
const EVENT_AUTHORITY_SEED = "__event_authority";
const DEFAULT_DECIMALS = 6;
class PumpFunSDK {
    program;
    connection;
    constructor(provider) {
        this.program = new Program(IDL, provider);
        this.connection = this.program.provider.connection;
    }
    async createAndBuy(creator, mint, createTokenMetadata, buyAmountSol, slippageBasisPoints = 500n, priorityFees, commitment = DEFAULT_COMMITMENT, finality = DEFAULT_FINALITY) {
        let tokenMetadata = await this.createTokenMetadata(createTokenMetadata);
        let createTx = await this.getCreateInstructions(creator.publicKey, createTokenMetadata.name, createTokenMetadata.symbol, tokenMetadata.metadataUri, mint);
        let newTx = new Transaction().add(createTx);
        if (buyAmountSol > 0) {
            const globalAccount = await this.getGlobalAccount(commitment);
            const buyAmount = globalAccount.getInitialBuyPrice(buyAmountSol);
            const buyAmountWithSlippage = calculateWithSlippageBuy(buyAmountSol, slippageBasisPoints);
            // Instead of calling getBuyInstructions which requires an existing bonding curve,
            // we'll create the buy instruction manually since we know the token is being created
            const bondingCurvePDA = this.getBondingCurvePDA(mint.publicKey);
            const associatedBondingCurve = await getAssociatedTokenAddress(mint.publicKey, bondingCurvePDA, true);
            // Create associated token account for user if needed
            const associatedUser = await this.createAssociatedTokenAccountIfNeeded(creator.publicKey, creator.publicKey, mint.publicKey, newTx, commitment);
            // Get event authority PDA
            const eventAuthorityPda = this.getEventAuthorityPda();
            // Get global account PDA
            const globalAccountPDA = this.getGlobalAccountPda();
            // Derive creator_vault PDA using the creator's public key (for createAndBuy, bonding curve doesn't exist yet)
            const creatorVaultPda = this.getCreatorVaultPda(creator.publicKey);
            // Create buy instruction using Anchor coder
            const buyInstructionData = this.program.coder.instruction.encode("buy", {
                amount: new bnExports.BN(buyAmount.toString()),
                maxSolCost: new bnExports.BN(buyAmountWithSlippage.toString())
            });
            // Create accounts array in the exact order
            const accounts = [
                { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
                { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true },
                { pubkey: mint.publicKey, isSigner: false, isWritable: false },
                { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
                { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
                { pubkey: associatedUser, isSigner: false, isWritable: true },
                { pubkey: creator.publicKey, isSigner: true, isWritable: true },
                { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
                { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
                { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
                { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
                { pubkey: this.program.programId, isSigner: false, isWritable: false }
            ];
            newTx.add(new TransactionInstruction({
                keys: accounts,
                programId: this.program.programId,
                data: buyInstructionData
            }));
        }
        let createResults = await sendTx(this.connection, newTx, creator.publicKey, [creator, mint], priorityFees, commitment, finality);
        return createResults;
    }
    async buy(buyer, mint, buyAmountSol, slippageBasisPoints = 500n, priorityFees, commitment = DEFAULT_COMMITMENT, finality = DEFAULT_FINALITY) {
        // Get bonding curve account
        const bondingCurvePDA = this.getBondingCurvePDA(mint);
        const bondingAccount = await this.getBondingCurveAccount(mint, commitment);
        if (!bondingAccount) {
            throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
        }
        // Get global account
        const globalAccountPDA = this.getGlobalAccountPda();
        const globalAccount = await this.getGlobalAccount(commitment);
        // Calculate buy amount
        const buyAmount = bondingAccount.getBuyPrice(buyAmountSol);
        const buyAmountWithSlippage = calculateWithSlippageBuy(buyAmountSol, slippageBasisPoints);
        // Get the associated token accounts
        const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurvePDA, true);
        // Get bonding curve creator using helper function
        const bondingCurveCreator = await this.getBondingCurveCreator(bondingCurvePDA, commitment);
        // Derive creator_vault PDA using bonding curve creator (not user public key)
        const creatorVaultPda = this.getCreatorVaultPda(bondingCurveCreator);
        // Get event authority PDA
        const eventAuthorityPda = this.getEventAuthorityPda();
        // Create a new transaction
        let transaction = new Transaction();
        // Add token account creation instruction if needed
        const associatedUser = await this.createAssociatedTokenAccountIfNeeded(buyer.publicKey, buyer.publicKey, mint, transaction, commitment);
        // Create buy instruction using Anchor coder
        const buyInstructionData = this.program.coder.instruction.encode("buy", {
            amount: new bnExports.BN(buyAmount.toString()),
            maxSolCost: new bnExports.BN(buyAmountWithSlippage.toString())
        });
        // Create accounts array in the exact order from buy_token_fixed.ts
        const accounts = [
            { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
            { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedUser, isSigner: false, isWritable: true },
            { pubkey: buyer.publicKey, isSigner: true, isWritable: true },
            { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false }, // SystemProgram
            { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }, // TokenProgram
            { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
            { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
            { pubkey: this.program.programId, isSigner: false, isWritable: false }
        ];
        // Add the buy instruction (manually created to ensure correct account order)
        transaction.add(new TransactionInstruction({
            keys: accounts,
            programId: this.program.programId,
            data: buyInstructionData
        }));
        // Send the transaction
        return await sendTx(this.connection, transaction, buyer.publicKey, [buyer], priorityFees, commitment, finality);
    }
    async sell(seller, mint, sellTokenAmount, slippageBasisPoints = 500n, priorityFees, commitment = DEFAULT_COMMITMENT, finality = DEFAULT_FINALITY) {
        // Get bonding curve account
        const bondingCurvePDA = this.getBondingCurvePDA(mint);
        const bondingAccount = await this.getBondingCurveAccount(mint, commitment);
        if (!bondingAccount) {
            throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
        }
        // Get global account
        const globalAccountPDA = this.getGlobalAccountPda();
        const globalAccount = await this.getGlobalAccount(commitment);
        // Calculate sell amount and slippage
        // Get exact price from bonding curve
        const minSolOutput = bondingAccount.getSellPrice(sellTokenAmount, globalAccount.feeBasisPoints);
        // Calculate with percentage-based slippage rather than a fixed value reduction
        let sellAmountWithSlippage = calculateWithSlippageSell(minSolOutput, slippageBasisPoints);
        // Make sure we don't go below 1 for very small amounts
        if (sellAmountWithSlippage < 1n) {
            sellAmountWithSlippage = 1n;
        }
        console.log(`Sell details: amount=${sellTokenAmount}, exactSolOutput=${minSolOutput}, withSlippage=${sellAmountWithSlippage}`);
        // Get the associated token accounts
        const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurvePDA, true);
        const sellerPublicKey = seller.publicKey;
        const associatedUser = await getAssociatedTokenAddress(mint, sellerPublicKey, false);
        // Get bonding curve creator using helper function
        const bondingCurveCreator = await this.getBondingCurveCreator(bondingCurvePDA, commitment);
        // Get the creator vault PDA
        const creatorVaultPda = this.getCreatorVaultPda(bondingCurveCreator);
        console.log("Creator vault PDA:", creatorVaultPda.toString());
        // Get event authority PDA
        const eventAuthorityPda = this.getEventAuthorityPda();
        // Create a new transaction
        let transaction = new Transaction();
        const sellInstructionData = this.program.coder.instruction.encode("sell", {
            amount: new bnExports.BN(sellTokenAmount.toString()),
            minSolOutput: new bnExports.BN(sellAmountWithSlippage.toString())
        });
        const sellAccounts = [
            { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
            { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedUser, isSigner: false, isWritable: true },
            { pubkey: sellerPublicKey, isSigner: true, isWritable: true },
            { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
            { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
            { pubkey: this.program.programId, isSigner: false, isWritable: false }
        ];
        let ix = new TransactionInstruction({
            keys: sellAccounts,
            programId: this.program.programId,
            data: sellInstructionData
        });
        transaction.add(ix);
        // Send the transaction
        return await sendTx(this.connection, transaction, sellerPublicKey, [seller], priorityFees, commitment, finality);
    }
    //create token instructions
    async getCreateInstructions(creator, name, symbol, uri, mint) {
        const mplTokenMetadata = new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID);
        const [metadataPDA] = PublicKey.findProgramAddressSync([
            Buffer.from(METADATA_SEED),
            mplTokenMetadata.toBuffer(),
            mint.publicKey.toBuffer(),
        ], mplTokenMetadata);
        const bondingCurvePDA = this.getBondingCurvePDA(mint.publicKey);
        const associatedBondingCurve = await getAssociatedTokenAddress(mint.publicKey, bondingCurvePDA, true);
        // Get mint authority PDA
        const [mintAuthorityPDA] = PublicKey.findProgramAddressSync([Buffer.from(MINT_AUTHORITY_SEED)], this.program.programId);
        // Get global account PDA
        const globalAccountPDA = this.getGlobalAccountPda();
        // Get event authority PDA
        const eventAuthorityPda = this.getEventAuthorityPda();
        // Create instruction manually to avoid typing issues
        const createInstructionData = this.program.coder.instruction.encode("create", {
            name: name,
            symbol: symbol,
            uri: uri,
            creator: creator
        });
        const createAccounts = [
            { pubkey: mint.publicKey, isSigner: true, isWritable: true }, // mint
            { pubkey: mintAuthorityPDA, isSigner: false, isWritable: false }, // mint_authority
            { pubkey: bondingCurvePDA, isSigner: false, isWritable: true }, // bonding_curve
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true }, // associated_bonding_curve
            { pubkey: globalAccountPDA, isSigner: false, isWritable: false }, // global
            { pubkey: mplTokenMetadata, isSigner: false, isWritable: false }, // mpl_token_metadata
            { pubkey: metadataPDA, isSigner: false, isWritable: true }, // metadata
            { pubkey: creator, isSigner: true, isWritable: true }, // user
            { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false }, // system_program
            { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }, // token_program
            { pubkey: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }, // associated_token_program
            { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false }, // rent
            { pubkey: eventAuthorityPda, isSigner: false, isWritable: false }, // event_authority
            { pubkey: this.program.programId, isSigner: false, isWritable: false } // program
        ];
        const createInstruction = new TransactionInstruction({
            keys: createAccounts,
            programId: this.program.programId,
            data: createInstructionData
        });
        return new Transaction().add(createInstruction);
    }
    async getBuyInstructionsBySolAmount(buyer, mint, buyAmountSol, slippageBasisPoints = 500n, commitment = DEFAULT_COMMITMENT) {
        let bondingCurveAccount = await this.getBondingCurveAccount(mint, commitment);
        if (!bondingCurveAccount) {
            throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
        }
        let buyAmount = bondingCurveAccount.getBuyPrice(buyAmountSol);
        let buyAmountWithSlippage = calculateWithSlippageBuy(buyAmountSol, slippageBasisPoints);
        let globalAccount = await this.getGlobalAccount(commitment);
        return await this.getBuyInstructions(buyer, mint, globalAccount.feeRecipient, buyAmount, buyAmountWithSlippage);
    }
    //buy
    async getBuyInstructions(buyer, mint, feeRecipient, amount, solAmount, commitment = DEFAULT_COMMITMENT) {
        const bondingCurvePDA = this.getBondingCurvePDA(mint);
        const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurvePDA, true);
        const associatedUser = await getAssociatedTokenAddress(mint, buyer, false);
        // Get bonding curve account to extract creator
        const bondingCurveAccountInfo2 = await this.connection.getAccountInfo(bondingCurvePDA);
        if (!bondingCurveAccountInfo2) {
            throw new Error("Bonding curve account not found");
        }
        // Get bonding curve creator using helper function
        const bondingCurveCreator = await this.getBondingCurveCreator(bondingCurvePDA, commitment);
        // Derive creator_vault PDA using bonding curve creator (not user public key)
        const creatorVaultPda = this.getCreatorVaultPda(bondingCurveCreator);
        // Get event authority PDA
        const eventAuthorityPda = this.getEventAuthorityPda();
        let transaction = new Transaction();
        try {
            await getAccount(this.connection, associatedUser, commitment);
        }
        catch (e) {
            transaction.add(createAssociatedTokenAccountInstruction(buyer, associatedUser, buyer, mint));
        }
        // Get global account PDA
        const globalAccountPDA = this.getGlobalAccountPda();
        // Create buy instruction using Anchor coder
        const buyInstructionData = this.program.coder.instruction.encode("buy", {
            amount: new bnExports.BN(amount.toString()),
            maxSolCost: new bnExports.BN(solAmount.toString())
        });
        const buyAccounts = [
            { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
            { pubkey: feeRecipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedUser, isSigner: false, isWritable: true },
            { pubkey: buyer, isSigner: true, isWritable: true },
            { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
            { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
            { pubkey: this.program.programId, isSigner: false, isWritable: false }
        ];
        transaction.add(new TransactionInstruction({
            keys: buyAccounts,
            programId: this.program.programId,
            data: buyInstructionData
        }));
        return transaction;
    }
    //sell
    async getSellInstructionsByTokenAmount(seller, mint, sellTokenAmount, slippageBasisPoints = 500n, commitment = DEFAULT_COMMITMENT) {
        let bondingCurveAccount = await this.getBondingCurveAccount(mint, commitment);
        if (!bondingCurveAccount) {
            throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
        }
        let globalAccount = await this.getGlobalAccount(commitment);
        // Get exact price from bonding curve
        const minSolOutput = bondingCurveAccount.getSellPrice(sellTokenAmount, globalAccount.feeBasisPoints);
        // Calculate with percentage-based slippage rather than a fixed value reduction
        let sellAmountWithSlippage = calculateWithSlippageSell(minSolOutput, slippageBasisPoints);
        // Make sure we don't go below 1 for very small amounts
        if (sellAmountWithSlippage < 1n) {
            sellAmountWithSlippage = 1n;
        }
        console.log(`getSellInstructionsByTokenAmount - amount=${sellTokenAmount}, exactOutput=${minSolOutput}, withSlippage=${sellAmountWithSlippage}`);
        return await this.getSellInstructions(seller, mint, globalAccount.feeRecipient, sellTokenAmount, sellAmountWithSlippage);
    }
    async getSellInstructions(seller, mint, feeRecipient, amount, minSolOutput, commitment = DEFAULT_COMMITMENT) {
        const bondingCurvePDA = this.getBondingCurvePDA(mint);
        const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurvePDA, true);
        const associatedUser = await getAssociatedTokenAddress(mint, seller, false);
        let transaction = new Transaction();
        // Get global account PDA
        const globalAccountPDA = this.getGlobalAccountPda();
        const bondingCurveCreator = await this.getBondingCurveCreator(bondingCurvePDA, commitment);
        // Derive creator_vault PDA using bonding curve creator
        const creatorVaultPda = this.getCreatorVaultPda(bondingCurveCreator);
        // Get event authority PDA
        const eventAuthorityPda = this.getEventAuthorityPda();
        // Check IDL for the correct order of accounts
        const accounts = [
            { pubkey: globalAccountPDA, isSigner: false, isWritable: false },
            { pubkey: feeRecipient, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurvePDA, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedUser, isSigner: false, isWritable: true },
            { pubkey: seller, isSigner: true, isWritable: true },
            { pubkey: new PublicKey(SYSTEM_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
            { pubkey: creatorVaultPda, isSigner: false, isWritable: true },
            { pubkey: eventAuthorityPda, isSigner: false, isWritable: false },
            { pubkey: this.program.programId, isSigner: false, isWritable: false }
        ];
        // Create the sell instruction with BN values for amount and minSolOutput
        const instructionData = this.program.coder.instruction.encode("sell", {
            amount: new bnExports.BN(amount.toString()),
            minSolOutput: new bnExports.BN(minSolOutput.toString())
        });
        // Add the instruction to the transaction
        transaction.add(new TransactionInstruction({
            keys: accounts,
            programId: this.program.programId,
            data: instructionData
        }));
        return transaction;
    }
    async getBondingCurveAccount(mint, commitment = DEFAULT_COMMITMENT) {
        const tokenAccount = await this.connection.getAccountInfo(this.getBondingCurvePDA(mint), commitment);
        if (!tokenAccount) {
            return null;
        }
        return BondingCurveAccount.fromBuffer(tokenAccount.data);
    }
    async getGlobalAccount(commitment = DEFAULT_COMMITMENT) {
        const globalAccountPDA = this.getGlobalAccountPda();
        const tokenAccount = await this.connection.getAccountInfo(globalAccountPDA, commitment);
        return GlobalAccount.fromBuffer(tokenAccount.data);
    }
    getBondingCurvePDA(mint) {
        return PublicKey.findProgramAddressSync([Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()], this.program.programId)[0];
    }
    async getBondingCurveCreator(bondingCurvePDA, commitment = DEFAULT_COMMITMENT) {
        const bondingAccountInfo = await this.connection.getAccountInfo(bondingCurvePDA, commitment);
        if (!bondingAccountInfo) {
            throw new Error("Bonding curve account not found");
        }
        // Creator is at offset 49 (after 8 bytes discriminator, 5 u64 fields, and 1 byte boolean)
        const creatorBytes = bondingAccountInfo.data.subarray(49, 49 + 32);
        return new PublicKey(creatorBytes);
    }
    async createTokenMetadata(create) {
        // Validate file
        if (!(create.file instanceof Blob)) {
            throw new Error('File must be a Blob or File object');
        }
        let formData = new FormData();
        formData.append("file", create.file, 'image.png'); // Add filename
        formData.append("name", create.name);
        formData.append("symbol", create.symbol);
        formData.append("description", create.description);
        formData.append("twitter", create.twitter || "");
        formData.append("telegram", create.telegram || "");
        formData.append("website", create.website || "");
        formData.append("showName", "true");
        try {
            const request = await fetch("https://pump.fun/api/ipfs", {
                method: "POST",
                headers: {
                    'Accept': 'application/json',
                },
                body: formData,
                credentials: 'same-origin'
            });
            if (request.status === 500) {
                // Try to get more error details
                const errorText = await request.text();
                throw new Error(`Server error (500): ${errorText || 'No error details available'}`);
            }
            if (!request.ok) {
                throw new Error(`HTTP error! status: ${request.status}`);
            }
            const responseText = await request.text();
            if (!responseText) {
                throw new Error('Empty response received from server');
            }
            try {
                return JSON.parse(responseText);
            }
            catch (e) {
                throw new Error(`Invalid JSON response: ${responseText}`);
            }
        }
        catch (error) {
            console.error('Error in createTokenMetadata:', error);
            throw error;
        }
    }
    getCreatorVaultPda(creator) {
        return PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBuffer()], this.program.programId)[0];
    }
    getGlobalAccountPda() {
        return PublicKey.findProgramAddressSync([Buffer.from(GLOBAL_ACCOUNT_SEED)], this.program.programId)[0];
    }
    getEventAuthorityPda() {
        return PublicKey.findProgramAddressSync([Buffer.from(EVENT_AUTHORITY_SEED)], this.program.programId)[0];
    }
    async createAssociatedTokenAccountIfNeeded(payer, owner, mint, transaction, commitment = DEFAULT_COMMITMENT) {
        const associatedTokenAccount = await getAssociatedTokenAddress(mint, owner, false);
        try {
            await getAccount(this.connection, associatedTokenAccount, commitment);
        }
        catch (e) {
            transaction.add(createAssociatedTokenAccountInstruction(payer, associatedTokenAccount, owner, mint));
        }
        return associatedTokenAccount;
    }
    //EVENTS
    addEventListener(eventType, callback) {
        return this.program.addEventListener(eventType, (event, slot, signature) => {
            let processedEvent;
            switch (eventType) {
                case "createEvent":
                    processedEvent = toCreateEvent(event);
                    callback(processedEvent, slot, signature);
                    break;
                case "tradeEvent":
                    processedEvent = toTradeEvent(event);
                    callback(processedEvent, slot, signature);
                    break;
                case "completeEvent":
                    processedEvent = toCompleteEvent(event);
                    callback(processedEvent, slot, signature);
                    break;
                case "setParamsEvent":
                    processedEvent = toSetParamsEvent(event);
                    callback(processedEvent, slot, signature);
                    break;
                default:
                    console.error("Unhandled event type:", eventType);
            }
        });
    }
    removeEventListener(eventId) {
        this.program.removeEventListener(eventId);
    }
}

class AMM {
    virtualSolReserves;
    virtualTokenReserves;
    realSolReserves;
    realTokenReserves;
    initialVirtualTokenReserves;
    constructor(virtualSolReserves, virtualTokenReserves, realSolReserves, realTokenReserves, initialVirtualTokenReserves) {
        this.virtualSolReserves = virtualSolReserves;
        this.virtualTokenReserves = virtualTokenReserves;
        this.realSolReserves = realSolReserves;
        this.realTokenReserves = realTokenReserves;
        this.initialVirtualTokenReserves = initialVirtualTokenReserves;
    }
    static fromGlobalAccount(global) {
        return new AMM(global.initialVirtualSolReserves, global.initialVirtualTokenReserves, 0n, global.initialRealTokenReserves, global.initialVirtualTokenReserves);
    }
    static fromBondingCurveAccount(bonding_curve, initialVirtualTokenReserves) {
        return new AMM(bonding_curve.virtualSolReserves, bonding_curve.virtualTokenReserves, bonding_curve.realSolReserves, bonding_curve.realTokenReserves, initialVirtualTokenReserves);
    }
    getBuyPrice(tokens) {
        const product_of_reserves = this.virtualSolReserves * this.virtualTokenReserves;
        const new_virtual_token_reserves = this.virtualTokenReserves - tokens;
        const new_virtual_sol_reserves = product_of_reserves / new_virtual_token_reserves + 1n;
        const amount_needed = new_virtual_sol_reserves > this.virtualSolReserves ? new_virtual_sol_reserves - this.virtualSolReserves : 0n;
        return amount_needed > 0n ? amount_needed : 0n;
    }
    applyBuy(token_amount) {
        const final_token_amount = token_amount > this.realTokenReserves ? this.realTokenReserves : token_amount;
        const sol_amount = this.getBuyPrice(final_token_amount);
        this.virtualTokenReserves = this.virtualTokenReserves - final_token_amount;
        this.realTokenReserves = this.realTokenReserves - final_token_amount;
        this.virtualSolReserves = this.virtualSolReserves + sol_amount;
        this.realSolReserves = this.realSolReserves + sol_amount;
        return {
            token_amount: final_token_amount,
            sol_amount: sol_amount
        };
    }
    applySell(token_amount) {
        this.virtualTokenReserves = this.virtualTokenReserves + token_amount;
        this.realTokenReserves = this.realTokenReserves + token_amount;
        const sell_price = this.getSellPrice(token_amount);
        this.virtualSolReserves = this.virtualSolReserves - sell_price;
        this.realSolReserves = this.realSolReserves - sell_price;
        return {
            token_amount: token_amount,
            sol_amount: sell_price
        };
    }
    getSellPrice(tokens) {
        const scaling_factor = this.initialVirtualTokenReserves;
        const token_sell_proportion = (tokens * scaling_factor) / this.virtualTokenReserves;
        const sol_received = (this.virtualSolReserves * token_sell_proportion) / scaling_factor;
        return sol_received < this.realSolReserves ? sol_received : this.realSolReserves;
    }
}

export { AMM, BONDING_CURVE_SEED, BondingCurveAccount, DEFAULT_COMMITMENT, DEFAULT_DECIMALS, DEFAULT_FINALITY, EVENT_AUTHORITY_SEED, GLOBAL_ACCOUNT_SEED, GlobalAccount, METADATA_SEED, MINT_AUTHORITY_SEED, PumpFunSDK, buildVersionedTx, calculateWithSlippageBuy, calculateWithSlippageSell, getTxDetails, sendTx, toCompleteEvent, toCreateEvent, toSetParamsEvent, toTradeEvent };
//# sourceMappingURL=index.js.map
