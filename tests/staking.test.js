const {cryptoWaitReady} = require("@polkadot/util-crypto");
const {ApiPromise, Keyring, WsProvider} = require("@polkadot/api");

const UNIT = BigInt(10 ** 12);
const MAX_UNBONDING_ERAS = 2;
const MIN_UNBONDING_ERAS = 0;
const SMALL_AMOUNT = UNIT;
const BIG_AMOUNT = 1_000_000_000_000n * UNIT;

const waitForInclusion = (tx, sender, opts = {}, finalize = false) => {
    return new Promise(async (resolve) => {
        await new Promise(r => setTimeout(r, 1000));
        const unsub = await tx.signAndSend(sender, opts, ({status, txHash}) => {
            if ((status.isInBlock && !finalize) || status.isFinalized) {
                unsub();
                resolve(txHash.toString());
            } else if (status.isDropped || status.isInvalid || status.isFinalityTimeout) {
                unsub();
                console.error(`Transaction ${txHash.toString()} failed:`, status.toString());
                resolve(txHash.toString());
            }
        });
    });
};

const parseBalance = balance => {
    return BigInt(typeof balance === 'string' ? balance.startsWith('0x') ? BigInt(balance) : balance : balance);
};

describe('Staking Tests', () => {
    const currentEra = async () => {
        const era = await api.query.staking.currentEra();
        return era.unwrap().toNumber();
    };
    const backOfUnbondingQueueEra = async () => {
        return (await api.query.staking.unbondingQueueParams()).unwrap().toJSON().backOfUnbondingQueueEra;
    };
    const keyring = new Keyring({type: 'sr25519'});
    let alice;
    let bob;
    let charlie;
    let provider;
    let api;

    beforeAll(async () => {
        await cryptoWaitReady();
        alice = keyring.addFromUri('//Alice');
        bob = keyring.addFromUri('//Bob');
        charlie = keyring.addFromUri('//Charlie');
        provider = new WsProvider('ws://127.0.0.1:8000');
        api = await ApiPromise.create({provider});
    }, 60_000);

    afterAll(async () => {
        await provider.disconnect();
        await api.disconnect();
    }, 60_000);

    test('Initial conditions', async () => {
        const eraLowestRatioTotalStake = (await api.query.staking.eraLowestRatioTotalStake()).toJSON();
        expect(eraLowestRatioTotalStake.length).toBeGreaterThanOrEqual(1);
        const [totalStake] = eraLowestRatioTotalStake;
        expect(parseBalance(totalStake)).toBeGreaterThan(0n);

        const unbondingQueueParams = (await api.query.staking.unbondingQueueParams()).unwrap().toJSON();
        expect(unbondingQueueParams).toEqual({
            minSlashableShare: 500000000,
            lowestRatio: 340000000,
            unbondPeriodLowerBound: MIN_UNBONDING_ERAS,
            backOfUnbondingQueueEra: 0,
        });

        const bondingDuration = (await api.consts.staking.bondingDuration).toNumber();
        expect(bondingDuration).toBe(MAX_UNBONDING_ERAS);
    });

    test('Force set balance', async () => {
        const setBalanceTx = api.tx.sudo.sudo(api.tx.balances.forceSetBalance(bob.address, BIG_AMOUNT * 2n));
        await waitForInclusion(setBalanceTx, alice);
    });

    test('Should be able to bond', async () => {
        const bobBondTx = api.tx.staking.bond(BIG_AMOUNT, 'Stash');
        await waitForInclusion(bobBondTx, bob);
    });

    test('Should be able to nominate', async () => {
        // Nominate Charlie as a validator.
        const validators = ['//Charlie//stash'].map(k => keyring.addFromUri(k).address);
        const nominateTx = api.tx.staking.nominate(validators);
        await waitForInclusion(nominateTx, charlie);
    });

    test("Zero‑stake unbond request should not create unlocking entry", async () => {
        const before = (await api.query.staking.ledger(bob.address))
            .unwrap()
            .unlocking.toJSON();
        expect(before.length).toBe(0);

        await waitForInclusion(api.tx.staking.unbond(0n), bob);

        const after = (await api.query.staking.ledger(bob.address))
            .unwrap()
            .unlocking.toJSON();
        expect(after.length).toBe(0);

        expect(await backOfUnbondingQueueEra()).toBe(0);
    });

    test(`Unbonding a small amount should yield ${MIN_UNBONDING_ERAS} eras`, async () => {
        expect(await backOfUnbondingQueueEra()).toBe(0);
        const unbondTx = api.tx.staking.unbond(SMALL_AMOUNT);
        await waitForInclusion(unbondTx, bob);

        const bobLedger = await api.query.staking.ledger(bob.address);
        const queue = bobLedger.unwrap().unlocking.toJSON();
        expect(queue.length).toBe(1);

        const [bobUnbonding] = queue;
        const era = await currentEra();
        expect(parseBalance(bobUnbonding.value)).toBe(SMALL_AMOUNT);
        expect(bobUnbonding.era).toBe(era + MIN_UNBONDING_ERAS);

        // delta = 0, so the back remains the same
        expect(await backOfUnbondingQueueEra()).toBe(era);
    });

    test("Multiple small unbonds merging into one entry", async () => {
        const era = await currentEra();
        await waitForInclusion(api.tx.staking.unbond(SMALL_AMOUNT), bob);

        const ledger = await api.query.staking.ledger(bob.address);
        const queue = ledger.unwrap().unlocking.toJSON();
        expect(queue.length).toBe(1);

        // Value should be doubled since two SMALL_AMOUNT unbonds merged
        expect(parseBalance(queue[0].value)).toBe(SMALL_AMOUNT * 2n);
        expect(queue[0].era).toBe(era + MIN_UNBONDING_ERAS);
        expect(await backOfUnbondingQueueEra()).toBe(era);
    });

    test("Rebonding before unbond completes clears unlocking and allows re‑unbond", async () => {
        // Cancel the two SMALL_AMOUNT unbonds
        await waitForInclusion(api.tx.staking.rebond(SMALL_AMOUNT * 2n), bob);

        // Now the unlocking queue should be empty
        let ledger = await api.query.staking.ledger(bob.address);
        let queue = ledger.unwrap().unlocking.toJSON();
        expect(queue.length).toBe(0);
        const era = await currentEra();
        expect(await backOfUnbondingQueueEra()).toBe(era);

        // Re‑create a fresh SMALL_AMOUNT unbond for next big‑unbond test
        await waitForInclusion(api.tx.staking.unbond(SMALL_AMOUNT), bob);

        ledger = await api.query.staking.ledger(bob.address);
        queue = ledger.unwrap().unlocking.toJSON();
        expect(queue.length).toBe(1);
        expect(parseBalance(queue[0].value)).toBe(SMALL_AMOUNT);
        expect(queue[0].era).toBe(era + MIN_UNBONDING_ERAS);

        expect(await backOfUnbondingQueueEra()).toBe(era);
    });

    test(`Unbond big amount should yield ${MAX_UNBONDING_ERAS} eras`, async () => {
        const bobLedger1 = await api.query.staking.ledger(bob.address);
        const total = bobLedger1.unwrap().active.toBigInt() - SMALL_AMOUNT * 2n;
        const unBondTx = api.tx.staking.unbond(total);
        await waitForInclusion(unBondTx, bob);

        const bobLedger2 = await api.query.staking.ledger(bob.address);
        const era = await currentEra();
        const queue = bobLedger2.unwrap().unlocking.toJSON();
        expect(queue.length).toBe(2);
        const last = queue[1];

        const lastValue = parseBalance(last.value);
        expect(lastValue).toBe(total);
        expect(last.era).toBe(era + MAX_UNBONDING_ERAS);
        expect(await backOfUnbondingQueueEra()).toBe(era + MAX_UNBONDING_ERAS);
    });

    test(`Unbond small amount should yield ${MAX_UNBONDING_ERAS} eras with unbonding queue full in the previous queue slot`, async () => {
        let bobLedger = await api.query.staking.ledger(bob.address);
        const lastAmount = parseBalance(bobLedger.unwrap().unlocking.toJSON()[1].value);

        const unBondTx = api.tx.staking.unbond(SMALL_AMOUNT);
        await waitForInclusion(unBondTx, bob);

        // Now this new small amount gets added up to the last unbond operation in the queue
        bobLedger = await api.query.staking.ledger(bob.address);
        const queue = bobLedger.unwrap().unlocking.toJSON();
        expect(queue.length).toBe(2);
        const last = queue[1];
        const era = await currentEra();

        const lastValue = parseBalance(last.value);
        expect(lastValue).toBe(lastAmount + SMALL_AMOUNT);
        expect(last.era).toBe(era + MAX_UNBONDING_ERAS);
    });

    // This MUST be the last test!
    test('Set staking config should work', async () => {
        if (!api.tx.sudo) {
            return;
        }
        const newConfig = {
            minSlashableShare: 800000000,
            lowestRatio: 500000000,
            unbondPeriodLowerBound: 1000,
            backOfUnbondingQueueEra: 55,
        };
        const tx = api.tx.sudo.sudo(api.tx.staking.setStakingConfigs({Noop: null}, {Noop: null}, {Noop: null}, {Noop: null}, {Noop: null}, {Noop: null}, {Noop: null}, {Set: newConfig},));
        await waitForInclusion(tx, alice);

        const unbondingQueueParams = (await api.query.staking.unbondingQueueParams()).unwrap().toJSON();
        expect(unbondingQueueParams).toEqual(newConfig);
    });
});
