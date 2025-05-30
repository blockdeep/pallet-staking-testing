const { cryptoWaitReady } = require('@polkadot/util-crypto')
const { ApiPromise, Keyring, WsProvider } = require('@polkadot/api')

const UNIT = BigInt(10 ** 12)
const MAX_UNBONDING_ERAS = 2
const MIN_UNBONDING_ERAS = 0
const SMALL_AMOUNT = UNIT
const BIG_AMOUNT = 1_000_000_000_000n * UNIT

const parseBalance = balance => {
  return BigInt(typeof balance === 'string' ? (balance.startsWith('0x') ? BigInt(balance) : balance) : balance)
}

describe('Staking Tests', () => {
  const currentEra = async () => {
    const era = await api.query.staking.currentEra()
    return era.unwrap().toNumber()
  }
  const waitForInclusion = (tx, sender, opts = {}, finalize = false) => {
    return new Promise(async (resolve, reject) => {
      await new Promise(r => setTimeout(r, 1000))
      const unsub = await tx.signAndSend(sender, opts, async ({ status, txHash }) => {
        if ((status.isInBlock && !finalize) || status.isFinalized) {
          unsub()
          const blockHash = status.isInBlock ? status.asInBlock : status.asFinalized
          const block = await api.rpc.chain.getBlock(blockHash)
          const events = await api.query.system.events.at(blockHash)
          const extrinsicIndex = block.block.extrinsics.findIndex(ext => ext.hash.eq(txHash))
          const extrinsicEvents = events.filter(
            ({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(extrinsicIndex)
          )
          const success = extrinsicEvents.some(({ event }) => api.events.system.ExtrinsicSuccess.is(event))
          if (!success) {
            console.error(
              `Transaction ${txHash.toString()} was included in a block, but did not succeed:`,
              status.toString()
            )
            reject({ hash: txHash.toString(), events: extrinsicEvents })
          } else {
            resolve({ hash: txHash.toString(), events: extrinsicEvents })
          }
        } else if (status.isDropped || status.isInvalid || status.isFinalityTimeout) {
          unsub()
          console.error(`Transaction ${txHash.toString()} was not included in a block:`, status.toString())
          resolve({ hash: txHash.toString(), events: [] })
        }
      })
    })
  }

  const keyring = new Keyring({ type: 'sr25519' })
  let alice
  let bob
  let charlie
  let provider
  let api

  beforeAll(async () => {
    await cryptoWaitReady()
    alice = keyring.addFromUri('//Alice')
    bob = keyring.addFromUri('//Bob')
    charlie = keyring.addFromUri('//Charlie')
    provider = new WsProvider('ws://127.0.0.1:8000')
    api = await ApiPromise.create({ provider })
  }, 60_000)

  afterAll(async () => {
    await provider.disconnect()
    await api.disconnect()
  }, 60_000)

  test('Initial conditions', async () => {
    const eraLowestRatioTotalStake = await api.query.staking.eraLowestRatioTotalStake.entries()
    expect(eraLowestRatioTotalStake.length).toBeGreaterThanOrEqual(1)
    const [totalStake] = eraLowestRatioTotalStake
    expect(parseBalance(totalStake[1])).toBeGreaterThan(0n)

    const unbondingQueueParams = (await api.query.staking.unbondingQueueParams()).unwrap().toJSON()
    expect(unbondingQueueParams).toEqual({
      minSlashableShare: 500000000,
      lowestRatio: 340000000,
      unbondPeriodLowerBound: MIN_UNBONDING_ERAS,
    })

    const bondingDuration = (await api.consts.staking.bondingDuration).toNumber()
    expect(bondingDuration).toBe(MAX_UNBONDING_ERAS)
  })

  test('Force set balance', async () => {
    const setBalanceTx = api.tx.sudo.sudo(api.tx.balances.forceSetBalance(bob.address, BIG_AMOUNT * 2n))
    await waitForInclusion(setBalanceTx, alice)
  })

  test('Should be able to bond', async () => {
    const bobBondTx = api.tx.staking.bond(BIG_AMOUNT, 'Stash')
    await waitForInclusion(bobBondTx, bob)
  })

  test('Should be able to nominate', async () => {
    // Nominate Charlie as a validator.
    const validators = ['//Charlie//stash'].map(k => keyring.addFromUri(k).address)
    const nominateTx = api.tx.staking.nominate(validators)
    await waitForInclusion(nominateTx, bob)
  })

  test('Zero‑stake unbond request should not create unlocking entry', async () => {
    const before = (await api.query.staking.ledger(bob.address)).unwrap().unlocking.toJSON()
    expect(before.length).toBe(0)

    await waitForInclusion(api.tx.staking.unbond(0n), bob)

    const after = (await api.query.staking.ledger(bob.address)).unwrap().unlocking.toJSON()
    expect(after.length).toBe(0)
  })

  test(`Unbonding a small amount should yield ${MIN_UNBONDING_ERAS} eras`, async () => {
    const unbondTx = api.tx.staking.unbond(SMALL_AMOUNT)
    await waitForInclusion(unbondTx, bob)

    const bobLedger = await api.query.staking.ledger(bob.address)
    const queue = bobLedger.unwrap().unlocking.toJSON()
    expect(queue.length).toBe(1)

    const [bobUnbonding] = queue
    const era = await currentEra()
    expect(parseBalance(bobUnbonding.value)).toBe(SMALL_AMOUNT)
    expect(bobUnbonding.era).toBe(era + MIN_UNBONDING_ERAS)
  })

  test('Multiple small unbonds merging into one entry', async () => {
    const era = await currentEra()
    await waitForInclusion(api.tx.staking.unbond(SMALL_AMOUNT), bob)

    const ledger = await api.query.staking.ledger(bob.address)
    const queue = ledger.unwrap().unlocking.toJSON()
    expect(queue.length).toBe(1)

    // Value should be doubled since two SMALL_AMOUNT unbonds merged
    expect(parseBalance(queue[0].value)).toBe(SMALL_AMOUNT * 2n)
    expect(queue[0].era).toBe(era + MIN_UNBONDING_ERAS)
  })

  test('Rebonding before unbond completes clears unlocking and allows re‑unbond', async () => {
    // Cancel the two SMALL_AMOUNT unbonds
    await waitForInclusion(api.tx.staking.rebond(SMALL_AMOUNT * 2n), bob)

    // Now the unlocking queue should be empty
    let ledger = await api.query.staking.ledger(bob.address)
    let queue = ledger.unwrap().unlocking.toJSON()
    expect(queue.length).toBe(0)
    const era = await currentEra()

    // Re‑create a fresh SMALL_AMOUNT unbond for next big‑unbond test
    await waitForInclusion(api.tx.staking.unbond(SMALL_AMOUNT), bob)

    ledger = await api.query.staking.ledger(bob.address)
    queue = ledger.unwrap().unlocking.toJSON()
    expect(queue.length).toBe(1)
    expect(parseBalance(queue[0].value)).toBe(SMALL_AMOUNT)
    expect(queue[0].era).toBe(era + MIN_UNBONDING_ERAS)
  })

  test(`Unbond big amount should yield ${MAX_UNBONDING_ERAS} eras`, async () => {
    const bobLedger1 = await api.query.staking.ledger(bob.address)
    const previousQueue = bobLedger1.unwrap().unlocking.toJSON()
    expect(previousQueue.length).toBe(1)
    const previousValue = parseBalance(previousQueue[0].value)
    const total = bobLedger1.unwrap().active.toBigInt()
    const unBondTx = api.tx.staking.unbond(total)
    await waitForInclusion(unBondTx, bob)

    const bobLedger2 = await api.query.staking.ledger(bob.address)
    const era = await currentEra()
    const queue = bobLedger2.unwrap().unlocking.toJSON()
    expect(queue.length).toBe(1)
    const last = queue[0]

    const lastValue = parseBalance(last.value)
    expect(lastValue).toBe(total + previousValue)
    expect(last.era).toBe(era)
  })

  test('Should be able to bond extra amount', async () => {
    const beforeLedger = await api.query.staking.ledger(bob.address)
    const beforeActive = beforeLedger.unwrap().active.toBigInt()

    const bondExtraTx = api.tx.staking.bondExtra(SMALL_AMOUNT)
    await waitForInclusion(bondExtraTx, bob)

    const afterLedger = await api.query.staking.ledger(bob.address)
    const afterActive = afterLedger.unwrap().active.toBigInt()
    expect(afterActive).toBe(beforeActive + SMALL_AMOUNT)
  })

  test('Should be able to chill', async () => {
    const chillTx = api.tx.staking.chill()
    await waitForInclusion(chillTx, bob)

    const nominations = await api.query.staking.nominators(bob.address)
    expect(nominations.isNone).toBe(true)
  })

  test('Should not be able to unbond more than bonded amount', async () => {
    const ledger = await api.query.staking.ledger(bob.address)
    const currentBonded = ledger.unwrap().active.toBigInt()
    const unbondTx = api.tx.staking.unbond(currentBonded + UNIT)
    const { events } = await waitForInclusion(unbondTx, bob)
    const unbondEvent = events.find(({ event }) => api.events.staking.Unbonded.is(event))
    expect(unbondEvent.event.data[1].toBigInt()).toBe(currentBonded)
  })

  // This MUST be the last test!
  test('Set staking config should work', async () => {
    const newConfig = {
      minSlashableShare: 800000000,
      lowestRatio: 500000000,
      unbondPeriodLowerBound: 1000,
    }
    const tx = api.tx.sudo.sudo(
      api.tx.staking.setStakingConfigs(
        { Noop: null },
        { Noop: null },
        { Noop: null },
        { Noop: null },
        { Noop: null },
        { Noop: null },
        { Noop: null },
        { Set: newConfig }
      )
    )
    await waitForInclusion(tx, alice)

    const unbondingQueueParams = (await api.query.staking.unbondingQueueParams()).unwrap().toJSON()
    expect(unbondingQueueParams).toEqual(newConfig)
  })
})
