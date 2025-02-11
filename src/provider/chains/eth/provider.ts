import { defaultAbiCoder } from '@ethersproject/abi';
import { getAddress } from '@ethersproject/address';
import { hexZeroPad, splitSignature } from '@ethersproject/bytes';
import { keccak256 } from '@ethersproject/keccak256';
import { serialize, UnsignedTransaction } from '@ethersproject/transactions';
import OneKeyConnect from '@onekeyfe/connect';
import BigNumber from 'bignumber.js';
import * as ethUtil from 'ethereumjs-util';

import { fromBigIntHex, toBigIntHex } from '../../../basic/bignumber-plus';
import { check, checkIsDefined } from '../../../basic/precondtion';
import {
  AddressValidation,
  SignedTx,
  TypedMessage,
  UnsignedTx,
} from '../../../types/provider';
import { Signer, Verifier } from '../../../types/secret';
import { BaseProvider } from '../../abc';

import { Geth } from './geth';
import { hashMessage, MessageTypes } from './sdk/message';

class Provider extends BaseProvider {
  get geth(): Promise<Geth> {
    return this.clientSelector((i) => i instanceof Geth);
  }

  get chainId(): number {
    return Number(this.chainInfo?.implOptions?.chainId);
  }

  verifyAddress(address: string): Promise<AddressValidation> {
    let isValid = false;
    let checksumAddress = '';

    try {
      checksumAddress = address.startsWith('0x') ? getAddress(address) : '';
      isValid = checksumAddress.length === 42;
    } catch (e) {
      console.error(e);
    }

    return Promise.resolve({
      normalizedAddress: checksumAddress.toLowerCase() || undefined,
      displayAddress: checksumAddress || undefined,
      isValid,
    });
  }

  async pubkeyToAddress(
    verifier: Verifier,
    encoding: string | undefined,
  ): Promise<string> {
    const pubkey = await verifier.getPubkey(false);
    return '0x' + keccak256(pubkey.slice(-64)).slice(-40);
  }

  async buildUnsignedTx(unsignedTx: UnsignedTx): Promise<UnsignedTx> {
    const input = unsignedTx.inputs[0];
    const output = unsignedTx.outputs[0];

    const payload = unsignedTx.payload || {};
    let nonce = unsignedTx.nonce;
    let feeLimit = unsignedTx.feeLimit;

    if (input && output) {
      const fromAddress = input.address;
      const tokenAddress = output.tokenAddress;
      let toAddress = output.address;
      let value: string = toBigIntHex(output.value);
      let data: string | undefined;

      if (tokenAddress) {
        data =
          '0xa9059cbb' +
          defaultAbiCoder
            .encode(['address', 'uint256'], [toAddress, value])
            .slice(2); // method_selector(transfer) + byte32_pad(address) + byte32_pad(value)
        value = '0x0';
        toAddress = tokenAddress;
      } else {
        data = payload.data;
      }

      if (typeof data === 'string' && data) {
        payload.data = data;
      }

      if (!feeLimit) {
        const estimatedGasLimit = await this.geth.then((client) =>
          client.estimateGasLimit(fromAddress, toAddress, value, data),
        );
        const estimatedGasLimitBN = fromBigIntHex(estimatedGasLimit);
        const multiplier =
          this.chainInfo.implOptions['contract_gaslimit_multiplier'] || 1.2;

        feeLimit =
          tokenAddress ||
          (await this.geth.then((client) => client.isContract(toAddress)))
            ? estimatedGasLimitBN.multipliedBy(multiplier).integerValue()
            : estimatedGasLimitBN;
      }

      if (typeof nonce !== 'number' || nonce < 0) {
        const [addressInfo] = await this.geth.then((client) =>
          client.getAddresses([fromAddress]),
        );
        nonce = addressInfo?.nonce;
      }
    }

    feeLimit = feeLimit || new BigNumber(21000);

    let feePricePerUnit = unsignedTx.feePricePerUnit;
    if (!feePricePerUnit) {
      const feePrice = await this.geth.then((i) => i.getFeePricePerUnit());
      const normal = feePrice.normal;
      feePricePerUnit = normal.price;

      if (normal.payload) {
        Object.assign(payload, normal.payload);
      }
    }

    return Object.assign(unsignedTx, {
      inputs: input ? [input] : [],
      outputs: output ? [output] : [],
      nonce,
      feeLimit,
      feePricePerUnit,
      payload,
    });
  }

  async signTransaction(
    unsignedTx: UnsignedTx,
    signers: { [address: string]: Signer },
  ): Promise<SignedTx> {
    const fromAddress = unsignedTx.inputs[0]?.address;
    check(fromAddress && signers[fromAddress], 'Signer not found');

    const tx = this.buildEtherUnSignedTx(unsignedTx);
    const digest = keccak256(serialize(tx));
    const [sig, recoveryParam] = await signers[fromAddress].sign(
      Buffer.from(digest.slice(2), 'hex'),
    );
    const [r, s]: [Buffer, Buffer] = [sig.slice(0, 32), sig.slice(32)];
    const signature = splitSignature({
      recoveryParam: recoveryParam,
      r: hexZeroPad('0x' + r.toString('hex'), 32),
      s: hexZeroPad('0x' + s.toString('hex'), 32),
    });

    const rawTx: string = serialize(tx, signature);
    const txid = keccak256(rawTx);
    return { txid, rawTx };
  }

  private buildEtherUnSignedTx(unsignedTx: UnsignedTx): UnsignedTransaction {
    const output = unsignedTx.outputs[0];
    const isERC20Transfer = !!output.tokenAddress;
    const toAddress = isERC20Transfer ? output.tokenAddress : output.address;
    const value = isERC20Transfer ? '0x0' : toBigIntHex(output.value);

    const baseTx = {
      to: toAddress,
      value,
      gasLimit: toBigIntHex(checkIsDefined(unsignedTx.feeLimit)),
      nonce: checkIsDefined(unsignedTx.nonce),
      data: unsignedTx.payload?.data || '0x',
      chainId: parseInt(checkIsDefined(this.chainInfo.implOptions.chainId)),
    };

    if (unsignedTx.payload?.EIP1559Enabled === true) {
      Object.assign(baseTx, {
        type: 2,
        maxFeePerGas: toBigIntHex(
          new BigNumber(checkIsDefined(unsignedTx.payload?.maxFeePerGas)),
        ),
        maxPriorityFeePerGas: toBigIntHex(
          new BigNumber(
            checkIsDefined(unsignedTx.payload?.maxPriorityFeePerGas),
          ),
        ),
      });
    } else {
      Object.assign(baseTx, {
        gasPrice: toBigIntHex(checkIsDefined(unsignedTx.feePricePerUnit)),
      });
    }

    return baseTx;
  }

  async signMessage(
    message: TypedMessage,
    signer: Signer,
    address?: string,
  ): Promise<string> {
    const messageHash = hashMessage(
      message.type as MessageTypes,
      message.message,
    );
    const [sig, recId] = await signer.sign(ethUtil.toBuffer(messageHash));
    return ethUtil.addHexPrefix(
      Buffer.concat([sig, Buffer.from([recId + 27])]).toString('hex'),
    );
  }

  async verifyMessage(
    address: string,
    message: TypedMessage,
    signature: string,
  ): Promise<boolean> {
    const recoveredAddress = await this.ecRecover(message, signature);
    return address.toLowerCase() === recoveredAddress.toLowerCase();
  }

  async ecRecover(message: TypedMessage, signature: string): Promise<string> {
    const messageHash = hashMessage(
      message.type as MessageTypes,
      message.message,
    );
    const hashBuffer = ethUtil.toBuffer(messageHash);
    const sigBuffer = ethUtil.toBuffer(signature);
    check(hashBuffer.length === 32, 'Invalid message hash length');
    check(sigBuffer.length === 65, 'Invalid signature length');

    const [r, s, v] = [
      sigBuffer.slice(0, 32),
      sigBuffer.slice(32, 64),
      sigBuffer[64],
    ];
    const publicKey = ethUtil.ecrecover(hashBuffer, v, r, s);
    return ethUtil.addHexPrefix(
      ethUtil.pubToAddress(publicKey).toString('hex'),
    );
  }

  async hardwareGetXpubs(
    paths: string[],
    showOnDevice: boolean,
  ): Promise<{ path: string; xpub: string }[]> {
    const resp = await this.wrapHardwareCall(() =>
      OneKeyConnect.ethereumGetPublicKey({
        bundle: paths.map((path) => ({ path, showOnTrezor: showOnDevice })),
      }),
    );

    return resp.map((i) => ({
      path: i.serializedPath,
      xpub: i.xpub,
    }));
  }

  async hardwareGetAddress(
    path: string,
    showOnDevice: boolean,
    addressToVerify?: string,
  ): Promise<string> {
    const params = {
      path,
      showOnTrezor: showOnDevice,
    };

    if (typeof addressToVerify === 'string') {
      Object.assign(params, {
        address: addressToVerify,
      });
    }
    const { address } = await this.wrapHardwareCall(() =>
      OneKeyConnect.ethereumGetAddress(params),
    );
    return address;
  }

  async hardwareSignTransaction(
    unsignedTx: UnsignedTx,
    signers: Record<string, string>,
  ): Promise<SignedTx> {
    const {
      inputs: [{ address: fromAddress }],
    } = unsignedTx;
    const signer = signers[fromAddress];
    check(signer, 'Signer not found');

    const tx = this.buildEtherUnSignedTx(unsignedTx);
    const { r, s, v } = await this.wrapHardwareCall(() =>
      OneKeyConnect.ethereumSignTransaction({
        path: signer,
        transaction: {
          to: tx.to,
          value: tx.value,
          gasPrice: tx.gasPrice,
          gasLimit: tx.gasLimit,
          nonce: ethUtil.addHexPrefix(
            ethUtil.padToEven(tx.nonce!.toString(16)),
          ),
          data: tx.data,
          chainId: tx.chainId,
        },
      } as never),
    );
    const signature = splitSignature({
      v: Number(v),
      r,
      s,
    });

    const rawTx: string = serialize(tx, signature);
    const txid = keccak256(rawTx);
    return { txid, rawTx };
  }

  async hardwareSignMessage(
    message: TypedMessage,
    signer: string,
  ): Promise<string> {
    const { type: messageType, message: strMessage } = message;

    switch (messageType) {
      case MessageTypes.ETH_SIGN:
        throw new Error('eth_sign is not supported for hardware');
      case MessageTypes.TYPE_DATA_V1:
        throw new Error('signTypedData_v1 is not supported for hardware');
      case MessageTypes.PERSONAL_SIGN: {
        const { signature } = await this.wrapHardwareCall(() =>
          OneKeyConnect.ethereumSignMessage({
            path: signer,
            message: strMessage,
          }),
        );
        return ethUtil.addHexPrefix(signature as string);
      }
      case MessageTypes.TYPE_DATA_V3:
      case MessageTypes.TYPE_DATA_V4: {
        const { signature } = await this.wrapHardwareCall(() =>
          // @ts-ignore
          OneKeyConnect.ethereumSignMessageEIP712({
            path: signer,
            version: messageType === MessageTypes.TYPE_DATA_V3 ? 'V3' : 'V4',
            data: JSON.parse(strMessage),
          } as never),
        );
        return ethUtil.addHexPrefix(signature as string);
      }
    }

    throw new Error(`Not supported`);
  }

  async hardwareVerifyMessage(
    address: string,
    message: TypedMessage,
    signature: string,
  ): Promise<boolean> {
    const { type: messageType, message: strMessage } = message;

    if (messageType === MessageTypes.PERSONAL_SIGN) {
      const { message: resp } = await this.wrapHardwareCall(() =>
        OneKeyConnect.ethereumVerifyMessage({
          address,
          message: strMessage,
          signature,
        }),
      );
      return resp === 'Message verified';
    }

    throw new Error('Not supported');
  }
}

export { Provider };
