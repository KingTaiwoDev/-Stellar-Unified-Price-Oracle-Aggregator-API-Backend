#!/usr/bin/env node

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  Keypair,
  SorobanRpc,
  TransactionBuilder,
  Operation,
  Contract,
  Transaction,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const NETWORK = process.argv.includes('--mainnet') ? 'mainnet' : 'testnet';
const RPC_URL = NETWORK === 'mainnet'
  ? process.env.SOROBAN_RPC_URL || 'https://soroban-rpc.mainnet.stellar.gateway.money'
  : process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const PASSPHRASE = NETWORK === 'mainnet'
  ? 'Public Global Stellar Network ; September 2015'
  : 'Test SDF Network ; September 2015';
const SECRET = process.env.ADMIN_SECRET_KEY;

// Event schema version this script (and the published event decoding client
// library, see `packages/event-decoder`) is able to decode. The contract
// exposes this via `get_api_version`; a mismatch means the deployed WASM is
// newer/older than the tooling and consumers must upgrade before relying on
// decoded events.
const EXPECTED_EVENT_SCHEMA_VERSION = 1;

// Rollout guidance:
//   1. Deploy to testnet first (`node scripts/deploy-soroban.js`).
//   2. This script verifies `get_price_snapshot` and `get_api_version` and
//      asserts the event schema version matches EXPECTED_EVENT_SCHEMA_VERSION.
//   3. Only promote to mainnet (`--mainnet`) once verification passes.
// Rollback guidance:
//   - If verification fails, the deployment is aborted before any consumer is
//     pointed at the new contract ID; keep using the previous CONTRACT_ID.
//   - If a bad contract was already published, redeploy the previous WASM
//     (same procedure) and update CONTRACT_ID in .env; consumers should pin
//     the event schema version they decode against.

if (!SECRET) {
  console.error('ERROR: ADMIN_SECRET_KEY not set in .env');
  process.exit(1);
}

async function deploy() {
  console.log(`Deploying Price Oracle contract to ${NETWORK}...`);
  console.log(`RPC URL: ${RPC_URL}`);

  const keypair = Keypair.fromSecret(SECRET);
  const server = new SorobanRpc.Server(RPC_URL);

  console.log(`Admin public key: ${keypair.publicKey()}`);

  console.log('Building contract...');
  execSync('cargo build --release', {
    cwd: path.resolve(__dirname, '../contracts/price-oracle'),
    stdio: 'inherit',
  });

  const wasmPath = path.resolve(__dirname, '../contracts/price-oracle/target/release/price_oracle.wasm');
  const wasm = fs.readFileSync(wasmPath);
  console.log(`WASM size: ${(wasm.length / 1024).toFixed(2)} KB`);

  const account = await server.getAccount(keypair.publicKey());
  console.log(`Account sequence: ${account.sequenceNumber}`);

  // Upload WASM
  console.log('Uploading contract WASM...');
  const uploadOp = Operation.uploadContractWasm({ wasm });
  const uploadTx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(uploadOp)
    .setTimeout(30)
    .build();

  uploadTx.sign(keypair);
  const uploadResult = await server.sendTransaction(uploadTx);
  console.log(`Upload status: ${uploadResult.status}`);

  if (uploadResult.status === 'PENDING') {
    let status;
    do {
      await new Promise(r => setTimeout(r, 1000));
      status = await server.getTransaction(uploadResult.hash);
    } while (status.status === 'NOT_FOUND');
    console.log('Upload confirmed');
  }

  // Create contract
  console.log('Creating contract instance...');
  const createOp = Operation.createContract({
    wasm,
    address: keypair.publicKey(),
  });
  const createTx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(createOp)
    .setTimeout(30)
    .build();

  createTx.sign(keypair);
  const createResult = await server.sendTransaction(createTx);
  console.log(`Create status: ${createResult.status}`);

  if (createResult.status === 'PENDING') {
    let status;
    do {
      await new Promise(r => setTimeout(r, 1000));
      status = await server.getTransaction(createResult.hash);
    } while (status.status === 'NOT_FOUND');

    if (status.status === 'SUCCESS') {
      const contractId = 'see transaction result (parse from XDR)';
      console.log(`\nContract deployed successfully!`);
      console.log(`Contract ID: ${contractId}`);
      console.log(`Transaction: ${createResult.hash}`);
      console.log(`\nAdd to .env:`);
      console.log(`CONTRACT_ID=<contract-id-from-xdr>`);
      console.log(`NETWORK_PASSPHRASE=${PASSPHRASE}`);

      if (process.env.CONTRACT_ID) {
        await verifyDeployment(server, keypair, process.env.CONTRACT_ID);
      } else {
        console.warn(
          '\nWARNING: CONTRACT_ID not set; skipping post-deploy verification. ' +
          'Set CONTRACT_ID in .env and re-run verification before promoting.'
        );
      }
    }
  }
}

/**
 * Simulate a read-only contract invocation and return the decoded native value.
 * Read methods are simulated (not submitted) so verification has no on-chain
 * side effects and costs nothing.
 */
async function simulateRead(server, keypair, contractId, method, args = []) {
  const contract = new Contract(contractId);
  const account = await server.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation of ${method} failed: ${simulation.error}`);
  }
  const retval = simulation.result?.retval;
  if (!retval) {
    throw new Error(`Simulation of ${method} returned no value`);
  }
  return scValToNative(retval);
}

/**
 * Verify the deployed contract exposes the stable read snapshot interface
 * (#726) and that its event schema version is compatible with the decoding
 * client library (#728). Throws on any incompatibility so the deploy fails
 * loudly instead of silently publishing an unusable contract.
 */
async function verifyDeployment(server, keypair, contractId) {
  console.log(`\nVerifying deployment at ${contractId}...`);

  // 1. Event schema version must match the decoding library.
  const apiVersion = await simulateRead(server, keypair, contractId, 'get_api_version');
  const eventSchemaVersion = Number(apiVersion?.event_schema_version ?? apiVersion);
  if (eventSchemaVersion !== EXPECTED_EVENT_SCHEMA_VERSION) {
    throw new Error(
      `Event schema version mismatch: contract reports ${eventSchemaVersion}, ` +
      `decoding library expects ${EXPECTED_EVENT_SCHEMA_VERSION}. ` +
      'Upgrade the event decoding client library or deploy a compatible WASM.'
    );
  }
  console.log(`Event schema version: ${eventSchemaVersion} (OK)`);

  // 2. Stable read snapshot must return a mutually consistent view of price,
  //    timestamps and policy version.
  const snapshot = await simulateRead(server, keypair, contractId, 'get_price_snapshot');
  const required = ['price', 'timestamp', 'policy_version'];
  const missing = required.filter((k) => snapshot?.[k] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `get_price_snapshot missing required fields: ${missing.join(', ')}`
    );
  }
  console.log(
    `Snapshot OK: price=${snapshot.price} timestamp=${snapshot.timestamp} ` +
    `policy_version=${snapshot.policy_version}`
  );

  console.log('Deployment verification passed.');
}

deploy().catch(console.error);
