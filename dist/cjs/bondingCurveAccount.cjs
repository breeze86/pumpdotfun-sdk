'use strict';

var borsh = require('@coral-xyz/borsh');

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
        const structure = borsh.struct([
            borsh.u64("discriminator"),
            borsh.u64("virtualTokenReserves"),
            borsh.u64("virtualSolReserves"),
            borsh.u64("realTokenReserves"),
            borsh.u64("realSolReserves"),
            borsh.u64("tokenTotalSupply"),
            borsh.bool("complete"),
        ]);
        let value = structure.decode(buffer);
        return new BondingCurveAccount(BigInt(value.discriminator), BigInt(value.virtualTokenReserves), BigInt(value.virtualSolReserves), BigInt(value.realTokenReserves), BigInt(value.realSolReserves), BigInt(value.tokenTotalSupply), value.complete);
    }
}

exports.BondingCurveAccount = BondingCurveAccount;
//# sourceMappingURL=bondingCurveAccount.cjs.map
