const {cryptoWaitReady} = require("@polkadot/util-crypto");
const {ApiPromise, Keyring, WsProvider} = require("@polkadot/api");

const UNIT = BigInt(10 ** 14);
const MAX_UNBONDING_ERAS = 28;
const MIN_UNBONDING_ERAS = 2;
const SMALL_AMOUNT = UNIT;

const waitForInclusion = (tx, sender, opts = {}, finalize = false) => {
    return new Promise(async (resolve) => {
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
    const keyring = new Keyring({type: 'sr25519'});
    let alice;
    let bob;
    let provider;
    let api;

    beforeAll(async () => {
        await cryptoWaitReady();
        alice = keyring.addFromUri('//Alice');
        bob = keyring.addFromUri('//Bob');
        provider = new WsProvider('ws://127.0.0.1:9944');
        api = await ApiPromise.create({provider});

        // Bond 3000 units from Alice. 1000 For the first three validators.
        const bobBondTx = api.tx.staking.bond(1_000_000n * UNIT, 'Stash');
        await waitForInclusion(bobBondTx, bob);

        // Nominate the three first validators
        const validators = ['//Alice//stash'].map(k => keyring.addFromUri(k).address);
        const nominateTx = api.tx.staking.nominate(validators);
        await waitForInclusion(nominateTx, alice);
    });

    afterAll(async () => {
        await provider.disconnect();
        await api.disconnect();
    }, 10000);

    test('Maximum bonding duration should be 28 days', async () => {
        const bondingDuration = (await api.consts.staking.bondingDuration).toNumber();
        expect(bondingDuration).toBe(MAX_UNBONDING_ERAS);
    });

    test('Unbond small amount should yield 2 eras', async () => {
        const unBondTx = api.tx.staking.unbond(SMALL_AMOUNT);
        await waitForInclusion(unBondTx, bob);

        const bobLedger = await api.query.staking.ledger(bob.address);
        const queue = bobLedger.unwrap().unlocking.toJSON();
        expect(queue.length).toBe(1);

        const [bobUnbonding] = queue;
        const era = await currentEra();
        expect(parseBalance(bobUnbonding.value)).toBe(SMALL_AMOUNT);
        expect(bobUnbonding.era).toBe(era + MIN_UNBONDING_ERAS);
    });

    test('Unbond big amount should yield 28 eras', async () => {
        let bobLedger = await api.query.staking.ledger(bob.address);
        const total = bobLedger.unwrap().active.toBigInt() - SMALL_AMOUNT;
        const unBondTx = api.tx.staking.unbond(total);
        await waitForInclusion(unBondTx, bob);

        bobLedger = await api.query.staking.ledger(bob.address);
        const queue = bobLedger.unwrap().unlocking.toJSON();
        expect(queue.length).toBe(2);
        const last = queue[1];
        const era = await currentEra();

        const lastValue = parseBalance(last.value);
        expect(lastValue).toBe(total);
        expect(last.era).toBe(era + MAX_UNBONDING_ERAS);
    });

    test('Unbond small amount should yield 28 eras with unbonding queue full', async () => {
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

    test('Set staking config should work', async () => {
        const tx = api.tx.sudo.sudo(api.tx.staking.setStakingConfigs(
            {Noop: null},
            {Noop: null},
            {Noop: null},
            {Noop: null},
            {Noop: null},
            {Noop: null},
            {Noop: null},
            {
                Set: {
                    minSlashableShare: 500000000,
                    lowestRatio: 340000000,
                    unbondPeriodLowerBound: MIN_UNBONDING_ERAS,
                    backOfUnbondingQueueEra: 0,
                }
            },
        ));
        await waitForInclusion(tx, alice);
    });
});
