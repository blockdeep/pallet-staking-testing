const { cryptoWaitReady } = require('@polkadot/util-crypto')
const { ApiPromise, Keyring, WsProvider } = require('@polkadot/api')

const UNIT = BigInt(10 ** 12)
const MAX_UNBONDING_ERAS = 2
const MIN_UNBONDING_ERAS = 0
const SMALL_AMOUNT = UNIT
const BIG_AMOUNT = 1_000_000_000_000n * UNIT

const parseBalance = balance => {
  if (typeof balance === 'string') {
    if (!balance.startsWith('0x')) {
      return BigInt(balance.replaceAll(',', ''))
    }
  }
  return BigInt(balance)
}

describe('Staking Tests', () => {
  const currentEra = async () => {
    const era = await api.query.staking.currentEra()
    return era.unwrap().toNumber()
  }

  const unbondingQueue = async address => {
    return (await api.query.staking.ledger(address))
      .unwrap()
      .unlocking.toJSON()
      .map(u => ({ ...u, value: parseBalance(u.value), previousUnbondedStake: parseBalance(u.previousUnbondedStake) }))
  }

  const expectedRelease = async address => {
    return (await api.call.stakingApi.unbondingDuration(address)).toJSON().map(duration => {
      duration[1] = parseBalance(duration[1])
      return duration
    })
  }

  const setLowestStake = async () => {
    const era = await currentEra()
    const storageKey = api.query.staking.eraLowestRatioTotalStake.key(era)
    const newValue = api.createType('Option<u128>', BIG_AMOUNT)
    const setStorageTx = api.tx.sudo.sudo(api.tx.system.setStorage([[storageKey, newValue.toHex()]]))
    await waitForInclusion(setStorageTx, alice)
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

  // Verifies initial staking conditions:
  // - Era lowest ratio total stake should exist and be greater than 0.
  // - Unbonding queue parameters should match expected values. This is a requirement before running other tests.
  // - Bonding duration should match MAX_UNBONDING_ERAS.
  test('Initial conditions', async () => {
    const eraLowestRatioTotalStake = await api.query.staking.eraLowestRatioTotalStake.entries()
    const length = eraLowestRatioTotalStake.length
    expect(length).toBeGreaterThanOrEqual(1)
    const totalStake = eraLowestRatioTotalStake[length - 1]
    expect(parseBalance(totalStake[1].unwrap().toBigInt())).toBeGreaterThan(0n)

    const unbondingQueueParams = (await api.query.staking.unbondingQueueParams()).unwrap().toJSON()
    expect(unbondingQueueParams).toEqual({
      minSlashableShare: 500000000,
      lowestRatio: 340000000,
      unbondPeriodLowerBound: MIN_UNBONDING_ERAS,
    })

    const bondingDuration = (await api.consts.staking.bondingDuration).toNumber()
    expect(bondingDuration).toBe(MAX_UNBONDING_ERAS)
  })

  // Sets Bob's balance to a large amount using sudo.
  // This is required to place enough stake for the rest of the tests.
  test('Force set balance', async () => {
    const setBalanceTx = api.tx.sudo.sudo(api.tx.balances.forceSetBalance(bob.address, BIG_AMOUNT * 2n))
    await waitForInclusion(setBalanceTx, alice)
  })

  // Tests bonding functionality by having Bob bond BIG_AMOUNT of tokens.
  // Verifies the Bonded event is emitted with correct parameters.
  test('Should be able to bond', async () => {
    const bobBondTx = api.tx.staking.bond(BIG_AMOUNT, 'Stash')
    const { events } = await waitForInclusion(bobBondTx, bob)
    const event = events.map(e => e.event.toHuman()).find(e => e.section === 'staking' && e.method === 'Bonded')
    expect(event).not.toBeUndefined()
    expect(event.data.stash).toBe(bob.address)
    expect(parseBalance(event.data.amount)).toBe(BIG_AMOUNT)
  })

  // Tests nomination functionality by having Bob nominate Charlie as validator.
  test('Should be able to nominate', async () => {
    // Nominate Charlie as a validator.
    const validators = ['//Charlie//stash'].map(k => keyring.addFromUri(k).address)
    const nominateTx = api.tx.staking.nominate(validators)
    const { events } = await waitForInclusion(nominateTx, bob)
    expect(events.map(e => e.event.toHuman()).find(e => e.section === 'staking')).toBeUndefined()
  })

  // Verifies that attempting to unbond zero tokens doesn't create an unlocking entry
  // in the unbonding queue.
  // It also verifies no bonding events are emitted, since this is a no-op.
  test('Zero‑stake unbond request should not create unlocking entry', async () => {
    const before = await unbondingQueue(bob.address)
    expect(before.length).toBe(0)

    const { events } = await waitForInclusion(api.tx.staking.unbond(0n), bob)
    expect(events.map(e => e.event.toHuman()).find(e => e.section === 'staking')).toBeUndefined()

    const after = await unbondingQueue(bob.address)
    expect(after.length).toBe(0)
  })

  // Tests unbonding of small amount of tokens:
  // - Sets lowest stake to ensure consistent behavior.
  // - Verifies unbonding event and queue entry.
  // - Confirms unbonding period is MIN_UNBONDING_ERAS, as the amount is very small when compared to the total
  //   stake in the system.
  test(`Unbonding a small amount should yield ${MIN_UNBONDING_ERAS} eras`, async () => {
    await setLowestStake()

    const unbondTx = api.tx.staking.unbond(SMALL_AMOUNT)
    const { events } = await waitForInclusion(unbondTx, bob)

    const event = events.map(e => e.event.toHuman()).find(e => e.section === 'staking' && e.method === 'Unbonded')
    expect(event).not.toBeUndefined()
    expect(event.data.stash).toBe(bob.address)
    expect(parseBalance(event.data.amount)).toBe(SMALL_AMOUNT)

    const queue = await unbondingQueue(bob.address)
    expect(queue.length).toBe(1)

    const era = await currentEra()
    const [bobUnbonding] = queue
    expect(bobUnbonding.value).toBe(SMALL_AMOUNT)
    expect(bobUnbonding.era).toBe(era)

    expect(await expectedRelease(bob.address)).toEqual([[era + MIN_UNBONDING_ERAS, SMALL_AMOUNT]])
  })

  // Tests that multiple small unbonding requests are merged into a single queue entry
  // with combined value.
  // It is counting with the previous test where already SMALL_AMOUNT was unbonded so that this test checks after
  // unbonding the same amount twice the total sum gets accumulated in a single unlock chunk if done in the same era.
  test('Multiple small unbonds merging into one entry', async () => {
    const era = await currentEra()
    const { events } = await waitForInclusion(api.tx.staking.unbond(SMALL_AMOUNT), bob)

    const event = events.map(e => e.event.toHuman()).find(e => e.section === 'staking' && e.method === 'Unbonded')
    expect(event).not.toBeUndefined()
    expect(event.data.stash).toBe(bob.address)
    expect(parseBalance(event.data.amount)).toBe(SMALL_AMOUNT)

    const queue = await unbondingQueue(bob.address)
    expect(queue.length).toBe(1)

    // Value should be doubled since two SMALL_AMOUNT unbonds merged.
    expect(queue[0].value).toBe(SMALL_AMOUNT * 2n)
    expect(queue[0].era).toBe(era)
  })

  // Tests rebonding behavior with large amounts:
  // - Verifies unbonding period increases to MAX_UNBONDING_ERAS for large amounts, as we are draining a huge percentage
  //   of the total stake, and that must have a penalty in terms of unbonding time.
  // - Confirms rebonding restores original state.
  test(`Rebonding a big amount should increase the expected unbonding era to ${MAX_UNBONDING_ERAS}}`, async () => {
    await setLowestStake()
    const era = await currentEra()

    const initialQueue = await unbondingQueue(bob.address)
    expect(initialQueue.length).toBe(1)
    const initialValue = initialQueue[0].value
    expect(await expectedRelease(bob.address)).toEqual([[era + MIN_UNBONDING_ERAS, initialValue]])

    // After this operation funds should be locked for a longer period of time
    const unbondAmount = (BIG_AMOUNT * 9n) / 10n
    await waitForInclusion(api.tx.staking.unbond(unbondAmount), bob)
    let queue = await unbondingQueue(bob.address)
    expect(queue.length).toBe(1)
    expect(queue[0].value).toBe(initialValue + unbondAmount)
    expect(queue[0].era).toBe(era)
    expect(await expectedRelease(bob.address)).toEqual([[era + MAX_UNBONDING_ERAS, initialValue + unbondAmount]])

    // This reverts the previous operation
    await waitForInclusion(api.tx.staking.rebond(unbondAmount), bob)
    queue = await unbondingQueue(bob.address)
    expect(queue.length).toBe(1)
    expect(parseBalance(queue[0].value)).toBe(initialValue)
    expect(queue[0].era).toBe(era)
    expect(await expectedRelease(bob.address)).toEqual([[era + MIN_UNBONDING_ERAS, initialValue]])
  })

  // Tests rebonding behavior when done before unbonding completes:
  // - Verifies that rebonding clears the unlocking queue
  // - Confirms ability to create new unbonding requests after rebonding
  test('Rebonding before unbond completes clears unlocking and allows re‑unbond', async () => {
    // Cancel the two SMALL_AMOUNT unbonds
    let { events } = await waitForInclusion(api.tx.staking.rebond(SMALL_AMOUNT * 2n), bob)

    let event = events.map(e => e.event.toHuman()).find(e => e.section === 'staking' && e.method === 'Bonded')
    expect(event).not.toBeUndefined()
    expect(event.data.stash).toBe(bob.address)
    expect(parseBalance(event.data.amount)).toBe(SMALL_AMOUNT * 2n)

    // Now the unlocking queue should be empty
    let queue = await unbondingQueue(bob.address)
    expect(queue.length).toBe(0)
    const era = await currentEra()

    // Re‑create a fresh SMALL_AMOUNT unbond for the next big unbond test
    events = (await waitForInclusion(api.tx.staking.unbond(SMALL_AMOUNT), bob)).events

    event = events.map(e => e.event.toHuman()).find(e => e.section === 'staking' && e.method === 'Unbonded')
    expect(event).not.toBeUndefined()
    expect(event.data.stash).toBe(bob.address)
    expect(parseBalance(event.data.amount)).toBe(SMALL_AMOUNT)

    queue = await unbondingQueue(bob.address)
    expect(queue.length).toBe(1)
    expect(parseBalance(queue[0].value)).toBe(SMALL_AMOUNT)
    expect(queue[0].era).toBe(era)
  })

  // Tests unbonding of large amount of stake:
  // - Verifies unbonding event and queue entry.
  // - Confirms unbonding period is the maximum.
  test(`Unbond big amount should yield ${MAX_UNBONDING_ERAS} eras`, async () => {
    const bobLedger1 = await api.query.staking.ledger(bob.address)
    const previousQueue = await unbondingQueue(bob.address)
    expect(previousQueue.length).toBe(1)
    const previousValue = parseBalance(previousQueue[0].value)
    const total = bobLedger1.unwrap().active.toBigInt()
    const unBondTx = api.tx.staking.unbond(total)
    const { events } = await waitForInclusion(unBondTx, bob)

    const event = events.map(e => e.event.toHuman()).find(e => e.section === 'staking' && e.method === 'Unbonded')
    expect(event).not.toBeUndefined()
    expect(event.data.stash).toBe(bob.address)
    expect(parseBalance(event.data.amount)).toBe(total)

    const era = await currentEra()
    const queue = await unbondingQueue(bob.address)
    expect(queue.length).toBe(1)
    const last = queue[0]

    const lastValue = parseBalance(last.value)
    expect(lastValue).toBe(total + previousValue)
    expect(last.era).toBe(era)

    expect(await expectedRelease(bob.address)).toEqual([[era + MAX_UNBONDING_ERAS, total + previousValue]])
  })

  // Tests bonding additional tokens to an existing bond:
  // - Verifies Bonded event emission.
  // - Confirms active stake increases by bonded amount.
  test('Should be able to bond extra amount', async () => {
    const beforeLedger = await api.query.staking.ledger(bob.address)
    const beforeActive = beforeLedger.unwrap().active.toBigInt()

    const bondExtraTx = api.tx.staking.bondExtra(SMALL_AMOUNT)
    const { events } = await waitForInclusion(bondExtraTx, bob)

    const event = events.map(e => e.event.toHuman()).find(e => e.section === 'staking' && e.method === 'Bonded')
    expect(event).not.toBeUndefined()
    expect(event.data.stash).toBe(bob.address)
    expect(parseBalance(event.data.amount)).toBe(SMALL_AMOUNT)

    const afterLedger = await api.query.staking.ledger(bob.address)
    const afterActive = afterLedger.unwrap().active.toBigInt()
    expect(afterActive).toBe(beforeActive + SMALL_AMOUNT)
  })

  // Tests chill functionality which stops the account from nominating:
  // - Verifies Chilled event emission.
  // - Confirms nominations are cleared.
  test('Should be able to chill', async () => {
    const chillTx = api.tx.staking.chill()
    const { events } = await waitForInclusion(chillTx, bob)

    const event = events.map(e => e.event.toHuman()).find(e => e.section === 'staking' && e.method === 'Chilled')
    expect(event).not.toBeUndefined()
    expect(event.data.stash).toBe(bob.address)

    const nominations = await api.query.staking.nominators(bob.address)
    expect(nominations.isNone).toBe(true)
  })

  // Tests that unbonding more than the bonded amount is limited to the actual bonded amount.
  test('Should not be able to unbond more than bonded amount', async () => {
    const ledger = await api.query.staking.ledger(bob.address)
    const currentBonded = ledger.unwrap().active.toBigInt()
    const unbondTx = api.tx.staking.unbond(currentBonded + UNIT)
    const { events } = await waitForInclusion(unbondTx, bob)
    const unbondEvent = events.find(({ event }) => api.events.staking.Unbonded.is(event))
    expect(unbondEvent.event.data[1].toBigInt()).toBe(currentBonded)
  })

  // Tests setting new staking configuration parameters:
  // - Updates minSlashableShare, lowestRatio, and unbondPeriodLowerBound.
  // - Verifies new configuration is applied.
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
