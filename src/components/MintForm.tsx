"use client"
import useUmiStore from '@/store/useUmiStore';
import { Switch } from '@headlessui/react';
import {
  createFungible
} from '@metaplex-foundation/mpl-token-metadata';
import {
  createMintWithAssociatedToken,
  findAssociatedTokenPda,
  transferSol,
} from '@metaplex-foundation/mpl-toolbox';
import {
  createGenericFile,
  generateSigner,
  none,
  percentAmount,
  sol,
  some,
  publicKey as toPublicKey
} from '@metaplex-foundation/umi';
import { useWallet } from '@solana/wallet-adapter-react';
import { createSetAuthorityInstruction, AuthorityType as TokenAuthorityType } from '@solana/spl-token';
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { useRef, useState } from 'react';

const FEE_ADDRESS = process.env.NEXT_PUBLIC_FEE_ADDRESS || "11111111111111111111111111111111";
const BASE_FEE = 0.02;
const MINT_AUTHORITY_FEE = 0.001;
const FREEZE_AUTHORITY_FEE = 0.001;

declare global {
  interface Window {
    solana: any;
  }
}

interface SocialLinks {
  website: string;
  twitter: string;
  telegram: string;
  discord: string;
}

interface UploadProgress {
  status: 'idle' | 'uploading' | 'done' | 'error' | 'retrying';
  message: string;
  progress: number;
}

interface TokenData {
  mint: string;
  metadata: string;
  tokenAddress: string;
}

export default function MintForm() {
  const { publicKey, sendTransaction } = useWallet();
  const { umi } = useUmiStore();

  const [tokenName, setTokenName] = useState('');
  const [tokenSymbol, setTokenSymbol] = useState('');
  const [initialSupply, setInitialSupply] = useState('');
  const [decimals, setDecimals] = useState('9');
  const [tokenImage, setTokenImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState('');
  const [description, setDescription] = useState('');
  const [revokeFreezeAuthority, setRevokeFreezeAuthority] = useState(false);
  const [revokeMintAuthority, setRevokeMintAuthority] = useState(false);
  const [showSocials, setShowSocials] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({
    status: 'idle',
    message: '',
    progress: 0
  });

  const [socialLinks, setSocialLinks] = useState<SocialLinks>({
    website: '',
    twitter: '',
    telegram: '',
    discord: ''
  });

  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [tokenAccountAddress, setTokenAccountAddress] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const withRetry = async <T,>(
    operation: () => Promise<T>,
    errorMessage: string,
    progressStart: number,
    progressEnd: number
  ): Promise<T | null> => {
    let attempts = 0;
    while (attempts < 3) {
      try {
        return await operation();
      } catch (error) {
        attempts++;
        if (attempts === 3) throw error;
        await delay(500 * attempts);
      }
    }
    return null;
  };

  const updateProgress = (status: UploadProgress['status'], message: string, progress = 0) => {
    setUploadProgress({ status, message, progress });
  };

  const handleImageChange = (e: any) => {
    if (e.target.files?.[0]) {
      const file = e.target.files[0];
      if (file.size > 5 * 1024 * 1024) return alert("Image too large (max 5MB)");
      setTokenImage(file);
      setImagePreview(URL.createObjectURL(file));
    }
  };

  const handleSocialChange = (key: keyof SocialLinks, value: string) => {
    setSocialLinks(prev => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    if (!publicKey || !tokenImage) return alert("Missing wallet or image");

    const decimalValue = parseInt(decimals);
    if (isNaN(decimalValue) || decimalValue < 0 || decimalValue > 9)
      return alert("Decimals must be between 0–9");

    if (!initialSupply) return alert("Enter initial supply");

    setIsLoading(true);

    try {
      updateProgress("uploading", "Processing fee...", 10);

      const totalFee =
        BASE_FEE +
        (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) +
        (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0);

      await transferSol(umi, {
        source: umi.identity,
        destination: toPublicKey(FEE_ADDRESS),
        amount: sol(totalFee),
      }).sendAndConfirm(umi);

      updateProgress("uploading", "Uploading image...", 20);

      const imgBuffer = await tokenImage.arrayBuffer();
      const generic = createGenericFile(new Uint8Array(imgBuffer), tokenImage.name, {
        contentType: tokenImage.type
      });

      const imgUpload = await umi.uploader.upload([generic]);
      const imageUrl = imgUpload[0];

      updateProgress("uploading", "Uploading metadata...", 40);

      const metadataJson = {
        name: tokenName,
        symbol: tokenSymbol,
        description,
        image: imageUrl,
        properties: {
          files: [{ uri: imageUrl, type: tokenImage.type }],
          socials: showSocials ? socialLinks : undefined
        }
      };

      const metadataUri = await umi.uploader.uploadJson(metadataJson);

      updateProgress("uploading", "Creating token...", 60);

      const mintKeypair = generateSigner(umi);
      const userKey = toPublicKey(publicKey.toBase58());
      const mintAmount = BigInt(Number(initialSupply) * Math.pow(10, decimalValue));

      await createMintWithAssociatedToken(umi, {
        mint: mintKeypair,
        owner: userKey,
        amount: mintAmount,
        decimals: decimalValue,
        mintAuthority: revokeMintAuthority ? undefined : umi.identity.publicKey,
        freezeAuthority: revokeFreezeAuthority ? undefined : umi.identity.publicKey
      }).sendAndConfirm(umi);

      await createFungible(umi, {
        mint: mintKeypair,
        authority: umi.identity,
        name: tokenName,
        symbol: tokenSymbol,
        uri: metadataUri,
        sellerFeeBasisPoints: percentAmount(0),
        decimals: decimalValue,
        creators: some([{ address: umi.identity.publicKey, share: 100, verified: true }]),
        collection: none(),
        uses: none(),
        isMutable: true
      }).sendAndConfirm(umi);

      const tokenAcc = findAssociatedTokenPda(umi, {
        mint: mintKeypair.publicKey,
        owner: userKey,
      });

      setTokenAccountAddress(tokenAcc.toString());
      setTokenData({
        mint: mintKeypair.publicKey.toString(),
        metadata: metadataUri,
        tokenAddress: tokenAcc.toString()
      });

      updateProgress("done", "Token created successfully!", 100);
    } catch (err) {
      console.error(err);
      updateProgress("error", "Error creating token", 0);
    }

    setIsLoading(false);
  };

  const ProgressIndicator = () => {
    if (uploadProgress.status === "idle") return null;

    const bgColor = {
      uploading: "bg-[#7C3AED]",
      retrying: "bg-yellow-500",
      done: "bg-green-500",
      error: "bg-red-500"
    }[uploadProgress.status];

    return (
      <div className="mt-3 mintx-progress">
        <div className="flex justify-between text-sm mb-1">
          <span className="text-gray-300">{uploadProgress.message}</span>
          <span className="text-gray-400">{uploadProgress.progress}%</span>
        </div>
        <div className="w-full bg-black/50 h-2 rounded-full">
          <div className={`h-2 rounded-full ${bgColor}`} style={{ width: `${uploadProgress.progress}%` }} />
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#060510] to-[#02020a] flex items-start md:items-center justify-center p-6">
      <div className="w-full max-w-[520px]">
        <div className="mintx-card">
          <div className="mintx-gradient-border" />

          <div style={{ position: 'relative', zIndex: 2 }}>
            <h2 className="mintx-title"
              style={{
                background: 'linear-gradient(90deg,#7C3AED,#EC4899)',
                WebkitBackgroundClip: 'text',
                color: 'transparent'
              }}>
              Token Details
            </h2>

            <form onSubmit={handleSubmit} className="space-y-3">

              {/* GRID: NAME / SYMBOL / DECIMALS / SUPPLY / IMAGE */}
              <div className="mintx-grid">
                <div className="g-name">
                  <label className="mintx-label">Name</label>
                  <input className="mintx-input" value={tokenName} onChange={e => setTokenName(e.target.value)} required />
                </div>

                <div className="g-symbol">
                  <label className="mintx-label">Symbol</label>
                  <input className="mintx-input" value={tokenSymbol} onChange={e => setTokenSymbol(e.target.value)} required />
                </div>

                <div className="g-decimals">
                  <label className="mintx-label">Decimals (0–9)</label>
                  <input type="number" min="0" max="9" className="mintx-input"
                    value={decimals} onChange={e => setDecimals(e.target.value)} required />
                  <p className="text-xs text-gray-400 mt-1">Most tokens use 9 decimals.</p>
                </div>

                <div className="g-image">
                  <label className="mintx-label">Token Logo</label>
                  <div className="mintx-image-box" onClick={() => fileInputRef.current?.click()}>
                    {!imagePreview ? (
                      <svg className="mintx-upload-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                      </svg>
                    ) : (
                      <img src={imagePreview} alt="preview" />
                    )}
                  </div>
                </div>

                {/* FIXED — Missing section restored */}
                <div className="g-supply">
                  <label className="mintx-label">Initial Supply</label>
                  <input className="mintx-input" value={initialSupply} onChange={e => setInitialSupply(e.target.value)} required />
                </div>

              </div>

              {/* DESCRIPTION */}
              <div>
                <label className="mintx-label">Description</label>
                <textarea className="mintx-input mintx-textarea"
                  value={description}
                  onChange={e => setDescription(e.target.value)} />
              </div>

              <input type="file" ref={fileInputRef} className="sr-only" accept="image/*" onChange={handleImageChange} />

              {/* REVOKE FREEZE + REVOKE MINT (2-column desktop, 1-column mobile) */}
              <div className="mintx-toggle-grid">
                
                {/* Revoke Freeze */}
                <div className="mintx-toggle-card">
                  <h3 className="text-sm font-medium text-white">
                    Revoke Freeze <span className="text-xs text-gray-400">(required)</span>
                  </h3>
                  <p className="text-xs text-gray-400 mt-1">
                    Required to create a liquidity pool
                  </p>
                  <div className="flex justify-between items-center mt-3">
                    <Switch checked={revokeFreezeAuthority} onChange={setRevokeFreezeAuthority}
                      className={revokeFreezeAuthority ? 'mintx-switch-active' : 'mintx-switch'}>
                      <span className={revokeFreezeAuthority ? 'mintx-switch-handle mintx-translate' : 'mintx-switch-handle'} />
                    </Switch>
                    <span className="text-xs text-gray-400">(0.1 SOL)</span>
                  </div>
                </div>

                {/* Revoke Mint */}
                <div className="mintx-toggle-card">
                  <h3 className="text-sm font-medium text-white">Revoke Mint</h3>
                  <p className="text-xs text-gray-400 mt-1">
                    Prevents any future increase in supply
                  </p>
                  <div className="flex justify-between items-center mt-3">
                    <Switch checked={revokeMintAuthority} onChange={setRevokeMintAuthority}
                      className={revokeMintAuthority ? 'mintx-switch-active' : 'mintx-switch'}>
                      <span className={revokeMintAuthority ? 'mintx-switch-handle mintx-translate' : 'mintx-switch-handle'} />
                    </Switch>
                    <span className="text-xs text-gray-400">(0.1 SOL)</span>
                  </div>
                </div>

              </div>

              {/* SOCIAL LINKS TOGGLE */}
              <div className="mintx-toggle-card flex justify-between items-center">
                <div>
                  <h3 className="text-sm font-medium text-white">Add Social Links</h3>
                  <p className="text-xs text-gray-400">Optional but recommended</p>
                </div>
                <Switch checked={showSocials} onChange={setShowSocials}
                  className={showSocials ? 'mintx-switch-active' : 'mintx-switch'}>
                  <span className={showSocials ? 'mintx-switch-handle mintx-translate' : 'mintx-switch-handle'} />
                </Switch>
              </div>

              {showSocials && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mintx-label">Website</label>
                    <input className="mintx-input" value={socialLinks.website} onChange={e => handleSocialChange('website', e.target.value)} />
                  </div>
                  <div>
                    <label className="mintx-label">Twitter</label>
                    <input className="mintx-input" value={socialLinks.twitter} onChange={e => handleSocialChange('twitter', e.target.value)} />
                  </div>
                  <div>
                    <label className="mintx-label">Telegram</label>
                    <input className="mintx-input" value={socialLinks.telegram} onChange={e => handleSocialChange('telegram', e.target.value)} />
                  </div>
                  <div>
                    <label className="mintx-label">Discord</label>
                    <input className="mintx-input" value={socialLinks.discord} onChange={e => handleSocialChange('discord', e.target.value)} />
                  </div>
                </div>
              )}

              <ProgressIndicator />

              <button type="submit"
                disabled={!publicKey || isLoading || !tokenImage}
                className="mintx-submit w-full mt-2">
                {!publicKey ? "Connect Wallet"
                  : isLoading ? "Processing..."
                    : "Create Token"}
              </button>

            </form>

            {/* RESULT BOX */}
            {tokenData && (
              <div className="mintx-small-box mt-4">
                <h3 className="text-lg font-semibold mb-2"
                  style={{
                    background: 'linear-gradient(90deg,#7C3AED,#EC4899)',
                    WebkitBackgroundClip: 'text',
                    color: 'transparent'
                  }}>
                  Token Created Successfully!
                </h3>

                <div className="space-y-2">
                  <div>
                    <label className="mintx-label">Mint Address</label>
                    <div className="bg-[#0b1230] p-2 rounded-md text-sm text-gray-300 break-all">
                      {tokenData.mint}
                    </div>
                  </div>

                  <div>
                    <label className="mintx-label">Metadata URI</label>
                    <div className="bg-[#0b1230] p-2 rounded-md text-sm text-gray-300 break-all">
                      {tokenData.metadata}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TOTAL COST BOX */}
            <div className="mintx-small-box mt-3 text-center">
              Total Cost: {(
                BASE_FEE +
                (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) +
                (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0)
              ).toFixed(3)} SOL

              <div className="text-xs mt-1 space-y-1">
                <div>Base Fee: {BASE_FEE} SOL</div>
                {revokeMintAuthority && <div>Revoke Mint: {MINT_AUTHORITY_FEE} SOL</div>}
                {revokeFreezeAuthority && <div>Revoke Freeze: {FREEZE_AUTHORITY_FEE} SOL</div>}
              </div>
            </div>

          </div>

        </div>
      </div>
    </div>
  );
}
