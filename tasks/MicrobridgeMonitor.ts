const { DefenderRelaySigner, DefenderRelayProvider } = require('defender-relay-client/lib/ethers');
const { ethers } = require('ethers');
const axios = require('axios');
const difference = (a, b) => a.filter((_) => !b.includes(_));
let SLACK_WEBHOOK_URL;
let SIGNER;

const GD_FUSE = '0x495d133B938596C9984d462F007B676bDc57eCEC';
const GD_CELO = '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A';
const MPBBRIDGE = '0xa3247276dbcc76dd7705273f766eb3e8a5ecf4a5';
const bridges = {
  fuse: {
    fuseBridge: '0x5B7cEfD0e7d952F7E400416F9c98fE36F1043822',
    celoBridge: '0x165aEb4184A0cc4eFb96Cb6035341Ba2265bA564',
    registry: '0x44a1E0A83821E239F9Cef248CECc3AC5b910aeD2',
  },
  staging: {
    fuseBridge: '0x1CD7a472FF2c6826252932CC8aC40473898d90E8',
    celoBridge: '0x0A6538C9DAc037f5313CaAEb42b19081993e3183',
    registry: '0x44a1E0A83821E239F9Cef248CECc3AC5b910aeD2',
  },
  production: {
    fuseBridge: '0x08fdf766694C353401350c225cAEB9C631dC3288',
    celoBridge: '0xfb152Fc469A3E9154f8AA60bbD6700EcBC357A54',
    registry: '0x44a1E0A83821E239F9Cef248CECc3AC5b910aeD2',
  },
};

const MpbBridgeABI = [
  'function bridgeToWithLz(address target,uint256 targetChainId,uint256 amount,bytes adapterParams) payable',
  'function estimateSendFee(uint16,address,address,uint256,bool,bytes) view returns (uint nativeFee,uint zroFee)',
];

const TokenBridgeABI = [
  'event BridgeRequest(address indexed,address indexed,uint256,uint256,bool,uint256,uint256 indexed)',
  'event ExecutedTransfer(address indexed,address indexed,address,uint256,uint256,uint256,uint256,uint256 indexed)',
  'function withdraw(address token,uint256 amount)',
];
const ERC20ABI = [
  'function balanceOf(address owner) view returns (uint balance)',
  'function transferAndCall(address recipient,uint256 amount,bytes data) returns (bool success)',
  'function approve(address spender,uint256 amount)',
];
const fuseRpc = new ethers.providers.JsonRpcProvider('https://rpc.fuse.io');
const celoRpc = new ethers.providers.JsonRpcProvider('https://forno.celo.org');

const handleError = async (msg) => {
  if (!SLACK_WEBHOOK_URL) return;
  const responses = await Promise.all(
    SLACK_WEBHOOK_URL.split(',').map((webhook) => axios.post(webhook, JSON.stringify({ text: msg })))
  );
  console.log(
    'SUCCEEDED: Sent slack webhook: \n',
    responses.map((_) => _.data)
  );
};

const checkProductionBridgeBalance = async (bridge) => {
  const FUSE_MIN_BRIDGE_BALANCE = 5000000;

  const gd = new ethers.Contract(GD_FUSE, ERC20ABI, fuseRpc);
  const gdCelo = new ethers.Contract(GD_CELO, ERC20ABI, celoRpc);
  const mpbBridge = new ethers.Contract(MPBBRIDGE, MpbBridgeABI, SIGNER);

  const fuseBalance = await gd.balanceOf(bridge.fuseBridge);
  const celoBalance = await gdCelo.balanceOf(bridge.celoBridge);
  const signerAddr = await SIGNER.getAddress();
  const network = await SIGNER.getChainId();
  console.log({
    network,
    signer: signerAddr,
    fuseBalance: fuseBalance.div(100).toString(),
    celoBalance: celoBalance.div(ethers.constants.WeiPerEther).toString(),
  });
  const result = {
    fuseBalance: fuseBalance.div(100).lt(FUSE_MIN_BRIDGE_BALANCE),
    celoBalance: celoBalance.div(ethers.constants.WeiPerEther).lt(FUSE_MIN_BRIDGE_BALANCE),
  };
  if (Object.values(result).find((_) => _)) {
    // check which network the signer is on as autotask signer can only be used for one network
    let balanceTxMsg;
    if ((network === 122 && result.celoBalance) || (network === 42220 && result.fuseBalance)) {
      try {
        const richBridge = new ethers.Contract(
          network === 122 ? bridge.fuseBridge : bridge.celoBridge,
          TokenBridgeABI,
          SIGNER
        );
        const poorBridgeAddr = network === 122 ? bridge.celoBridge : bridge.fuseBridge;

        const amount = (network === 122 ? fuseBalance : celoBalance).mul(70).div(100); //bridge 70% of balance
        let signerBalance = network === 122 ? await gd.balanceOf(signerAddr) : await gdCelo.balanceOf(signerAddr);
        //if we already have some balance that we didnt send then skip withdraw
        let tx;
        if (signerBalance.eq(0)) {
          console.log('withdrawing from microbridge:', amount.toString());
          tx = await (await richBridge.withdraw(network === 122 ? gd.address : gdCelo.address, amount))
            .wait()
            .catch((e) => {
              console.log('bridge withdraw failed:', e.message, e);
              return { hash: 'failed' };
            });
          console.log('bridge withdraw result', tx);
        }

        signerBalance = network === 122 ? await gd.balanceOf(signerAddr) : await gdCelo.balanceOf(signerAddr);
        console.log('signer balance:', signerBalance.div(100).toString());

        if (signerBalance.gt(0)) {
          // target chain, target address, withoutRelay
          const lzAdapterParams = ethers.utils.solidityPack(['uint16', 'uint256'], [1, 400000]); // 400k gas to exec
          const { nativeFee: fee } = await mpbBridge.estimateSendFee(
            network === 122 ? 125 : 138,
            signerAddr,
            signerAddr,
            1,
            false,
            lzAdapterParams
          ); // except for chainid and lzadapter params the rest of vars do not matter

          await (network === 122 ? gd : gdCelo).connect(SIGNER).approve(mpbBridge.address, signerBalance);
          console.log(
            'bridging via lz....',
            poorBridgeAddr,
            network === 122 ? 42220 : 122,
            signerBalance.toString(),
            lzAdapterParams,
            { value: fee.toString() }
          );
          const bridgeTx = await (
            await mpbBridge.bridgeToWithLz(
              poorBridgeAddr,
              network === 122 ? 42220 : 122,
              signerBalance,
              lzAdapterParams,
              { value: fee, gasLimit: 1e6 }
            )
          ).wait();
          balanceTxMsg = `Balanced bridges: withdraw tx: ${tx?.transactionHash} bridgeTx: ${bridgeTx.transactionHash}`;
        }
      } catch (e: any) {
        balanceTxMsg = `Balancing bridges failed: ${e.message.slice(0, 100)}`;
      }
    }
    const msg = `Microbridge production low balance: ${JSON.stringify(result)}\nbalanceTx:${balanceTxMsg}`;
    console.log(msg);
    await handleError(msg);
    return false;
  }
  return true;
};

const checkStaleRequests = async (creds) => {
  const blocksAgo = -1000; //~83 minutes
  SLACK_WEBHOOK_URL = creds.secrets.SLACK_WEBHOOK_URL;
  const provider = new DefenderRelayProvider(creds);
  SIGNER = new DefenderRelaySigner(creds, provider, { speed: 'fastest', validForSeconds: 120 });
  const balanceResult = await checkProductionBridgeBalance(bridges.production);
  const ps = Object.entries(bridges).map(async ([k, bridge]) => {
    console.log('running bridge:', k, bridge);
    const bridgeA = new ethers.Contract(bridge.fuseBridge, TokenBridgeABI, fuseRpc);
    const bridgeB = new ethers.Contract(bridge.celoBridge, TokenBridgeABI, celoRpc);
    const bridgeARequests = await bridgeA.queryFilter(bridgeA.filters.BridgeRequest(), blocksAgo, -80);
    const bridgeAExecuted = await bridgeA.queryFilter(bridgeA.filters.ExecutedTransfer(), blocksAgo * 1.5);
    const bridgeBRequests = await bridgeB.queryFilter(bridgeB.filters.BridgeRequest(), blocksAgo, -80);
    const bridgeBExecuted = await bridgeB.queryFilter(bridgeB.filters.ExecutedTransfer(), blocksAgo * 1.5);

    const aRequests = bridgeARequests.map((e) => e.args?.[6].toString());
    const aExecuted = bridgeAExecuted.map((e) => e.args?.[7].toString());
    const bRequests = bridgeBRequests.map((e) => e.args?.[6].toString());
    const bExecuted = bridgeBExecuted.map((e) => e.args?.[7].toString());

    const fuseNotExecuted = difference(aRequests, bExecuted);
    const celoNotExecuted = difference(bRequests, aExecuted);
    console.log('found on fuse:', bridge.fuseBridge, { aRequests, aExecuted, fuseNotExecuted });
    console.log('found requests celo:', bridge.celoBridge, { bRequests, bExecuted, celoNotExecuted });
    if (k === 'production' && (celoNotExecuted.length || fuseNotExecuted.length)) {
      const msg = `${k}: Microbridge not executed. ${JSON.stringify(bridge)} celoNotExecuted:${
        celoNotExecuted.length
      }, fuseNotExecuted:${fuseNotExecuted.length}`;
      await handleError(msg);
      return false;
    }
    return true;
  });

  const results = await Promise.all(ps);
  results.push(balanceResult);
  console.log('results passed:', results);
  if (results.findIndex((_) => _ === false) >= 0) return;
  console.log('pinging heartbeat on betteruptime...');
  //if no errors ping bridge heart beat status
  await axios.get('https://betteruptime.com/api/v1/heartbeat/MP7XubdJQzTX1bqp9W6KGc1L');
};

exports.handler = checkStaleRequests;
