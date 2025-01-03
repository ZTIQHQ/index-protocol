import { Signer } from "ethers";
import { BigNumber } from "ethers";

import {
  AssetLimitHook,
  AMMSplitter,
  BridgedSetToken,
  CachedSetValuer,
} from "../contracts";

import { AssetLimitHook__factory } from "../../typechain/factories/AssetLimitHook__factory";
import { AMMSplitter__factory } from "../../typechain/factories/AMMSplitter__factory";
import { BridgedSetToken__factory } from "../../typechain/factories/BridgedSetToken__factory";
import { CachedSetValuer__factory } from "../../typechain/factories/CachedSetValuer__factory";
import { Address } from "../types";

export default class DeployProduct {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployAssetLimitHook(
    _assets: Address[],
    _limits: BigNumber[]
  ): Promise<AssetLimitHook> {
    return await new AssetLimitHook__factory(this._deployerSigner).deploy(_assets, _limits);
  }

  public async getAssetLimitHook(assetLimitHookAddress: Address): Promise<AssetLimitHook> {
    return await new AssetLimitHook__factory(this._deployerSigner).attach(assetLimitHookAddress);
  }

  public async deployAMMSplitter(
    uniRouter: Address,
    sushiRouter: Address,
    uniFactory: Address,
    sushiFactory: Address
  ): Promise<AMMSplitter> {
    return await new AMMSplitter__factory(this._deployerSigner).deploy(uniRouter, sushiRouter, uniFactory, sushiFactory);
  }

  public async deployBridgedSetToken(
    _name: string,
    _symbol: string,
  ): Promise<BridgedSetToken> {
    return await new BridgedSetToken__factory(this._deployerSigner).deploy(
      _name,
      _symbol,
    );
  }

  public async deployCachedSetValuer(
    controller: Address,
    setValuer: Address,
    rebasingModule: Address,
    maxStaleness: BigNumber
  ): Promise<CachedSetValuer> {
    return await new CachedSetValuer__factory(this._deployerSigner).deploy(
      controller,
      setValuer,
      rebasingModule,
      maxStaleness
    );
  }
}
