"use client";
import useUmiStore from "@/store/useUmiStore";
import { Switch } from "@headlessui/react";
import { createFungible } from "@metaplex-foundation/mpl-token-metadata";
import {
  createMintWithAssociatedToken,
  findAssociatedTokenPda,
  transferSol,
} from "@metaplex-foundation/mpl-toolbox";
import {
  createGenericFile,
  generateSigner,
  none,
  percentAmount,
  sol,
  some,
  publicKey as toPublicKey,
} from "@metaplex-foundation/umi";
import { useWallet } from "@solana/wallet-adapter-react";
import { createSetAuthorityInstruction, AuthorityType as TokenAuthorityType } from "@solana/spl-token";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { useRef, useState } from "react";

// FEES
const FEE_ADDRESS = process.env.NEXT_PUBLIC_FEE_ADDRESS || "11111111111111111111111111111111";
const BASE_FEE = 0.05;
const MINT_AUTHORITY_FEE = 0.0123;
const FREEZE_AUTHORITY_FEE = 0.0123;

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
  status: "idle" | "uploading" | "done" | "error" | "retrying";
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

  const [tokenName, setTokenName] = useState<string>("");
  const [tokenSymbol, setTokenSymbol] = useState<string>("");
  const [initialSupply, setInitialSupply] = useState<string>("");
  const [decimals, setDecimals] = useState<string>("9");
  const [tokenImage, setTokenImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string>("");
  const [description, setDescription] = useState<string>("");

  const [revokeFreezeAuthority, setRevokeFreezeAuthority] = useState<boolean>(false);
  const [revokeMintAuthority, setRevokeMintAuthority] = useState<boolean>(false);
  const [showSocials, setShowSocials] = useState<boolean>(false);

  const [socialLinks, setSocialLinks] = useState<SocialLinks>({
    website: "",
    twitter: "",
    telegram: "",
    discord: "",
  });

  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({
    status: "idle",
    message: "",
    progress: 0,
  });

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [tokenData, setTokenData] = useState<TokenData | null>(null);
  const [tokenAccountAddress, setTokenAccountAddress] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Update progress handler
  const updateProgress = (status: UploadProgress["status"], message: string, progress = 0) => {
    setUploadProgress({ status, message, progress });
  };

  // Handle image upload
  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement> | any) => {
    const file = e?.target?.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert("Image too large (max 5MB)");
      return;
    }
    setTokenImage(file);
    setImagePreview(URL.createObjectURL(file));
  };

  // Handle social change
  const handleSocialChange = (key: keyof SocialLinks, value: string) => {
    setSocialLinks((prev) => ({ ...prev, [key]: value }));
  };

  // Submit handler (keeps original flow)
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return alert("Connect wallet first");
    if (!tokenImage) return alert("Upload token logo");
    const decimalValue = Number(decimals);
    if (decimalValue < 0 || decimalValue > 9) return alert("Decimals must be between 0–9");
    if (!initialSupply || Number(initialSupply) <= 0) return alert("Enter a valid initial supply");

    const mintAmount = BigInt(Number(initialSupply) * Math.pow(10, decimalValue));

    try {
      setIsLoading(true);
      updateProgress("uploading", "Processing fee...", 10);

      const totalFee = BASE_FEE + (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) + (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0);

      await transferSol(umi, {
        source: umi.identity,
        destination: toPublicKey(FEE_ADDRESS),
        amount: sol(totalFee),
      }).sendAndConfirm(umi);

      updateProgress("uploading", "Uploading image...", 20);

      const buffer = await tokenImage.arrayBuffer();
      const file = createGenericFile(new Uint8Array(buffer), tokenImage.name, {
        contentType: tokenImage.type,
      });

      const uploadedImg = await umi.uploader.upload([file]);
      const imageUrl = uploadedImg[0];

      updateProgress("uploading", "Uploading metadata...", 40);

      const metadata = {
        name: tokenName,
        symbol: tokenSymbol,
        description,
        image: imageUrl,
        properties: {
          files: [{ uri: imageUrl, type: tokenImage.type }],
          socials: showSocials ? socialLinks : undefined,
        },
      };

      const metadataUri = await umi.uploader.uploadJson(metadata);

      updateProgress("uploading", "Creating token...", 60);

      const mintKeypair = generateSigner(umi);
      const userKey = toPublicKey(publicKey.toBase58());

      await createMintWithAssociatedToken(umi, {
        mint: mintKeypair,
        owner: userKey,
        amount: mintAmount,
        decimals: decimalValue,
        mintAuthority: revokeMintAuthority ? undefined : umi.identity.publicKey,
        freezeAuthority: revokeFreezeAuthority ? undefined : umi.identity.publicKey,
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
        isMutable: true,
      }).sendAndConfirm(umi);

      const tokenAcc = findAssociatedTokenPda(umi, {
        mint: mintKeypair.publicKey,
        owner: userKey,
      });

      setTokenAccountAddress(tokenAcc.toString());
      setTokenData({
        mint: mintKeypair.publicKey.toString(),
        metadata: metadataUri,
        tokenAddress: tokenAcc.toString(),
      });

      updateProgress("done", "Token created successfully!", 100);
    } catch (err) {
      console.error(err);
      updateProgress("error", "Token creation failed", 0);
    } finally {
      setIsLoading(false);
    }
  };

  // Progress UI
  const ProgressIndicator = () => {
    if (uploadProgress.status === "idle") return null;

    const bgColor =
      uploadProgress.status === "done"
        ? "bg-green-500"
        : uploadProgress.status === "error"
        ? "bg-red-500"
        : "bg-[#7C3AED]";

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

          <div style={{ position: "relative", zIndex: 2 }}>
            <h2
              className="mintx-title"
              style={{
                background: "linear-gradient(90deg,#7C3AED,#EC4899)",
                WebkitBackgroundClip: "text",
                color: "transparent",
              }}
            >
              Token Details
            </h2>

            <form onSubmit={handleSubmit} className="space-y-3">
              {/* MAIN GRID */}
              <div
                className="mintx-grid grid gap-4"
                style={{
                  gridTemplateColumns: "1fr 150px",
                  alignItems: "start",
                }}
              >
                {/* Left column inputs (stack) */}
                <div style={{ minWidth: 0 }}>
                  <div className="grid grid-cols-1 gap-4">
                    <div>
                      <label className="mintx-label">Name</label>
                      <input className="mintx-input" value={tokenName} onChange={(e) => setTokenName(e.target.value)} required />
                    </div>

                    <div>
                      <label className="mintx-label">Symbol</label>
                      <input className="mintx-input" value={tokenSymbol} onChange={(e) => setTokenSymbol(e.target.value)} required />
                    </div>

                    <div>
                      <label className="mintx-label">Decimals (0–9)</label>
                      <input
                        type="number"
                        min="0"
                        max="9"
                        className="mintx-input"
                        value={decimals}
                        onChange={(e) => setDecimals(e.target.value)}
                        required
                      />
                      <p className="text-xs text-gray-400 mt-1">Most tokens use 9 decimals.</p>
                    </div>

                    <div>
                      <label className="mintx-label">Initial Supply</label>
                      <input className="mintx-input" value={initialSupply} onChange={(e) => setInitialSupply(e.target.value)} required />
                    </div>
                  </div>
                </div>

                {/* Right column — fixed 150x150 box for token logo */}
                <div className="flex justify-center md:justify-end">
                  <div
                    className="mintx-image-box cursor-pointer flex items-center justify-center"
                    onClick={() => fileInputRef.current?.click()}
                    style={{
                      width: 150,
                      height: 150,
                      minWidth: 150,
                      minHeight: 150,
                      borderRadius: 18,
                      overflow: "hidden",
                      position: "relative",
                      background: "#0b0f1a",
                      border: "1px solid rgba(255,255,255,0.04)",
                    }}
                    aria-label="Upload token logo"
                  >
                    {/* Circular inner: Orion-circle style */}
                    <div
                      style={{
                        width: 124,
                        height: 124,
                        borderRadius: "9999px",
                        overflow: "hidden",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: imagePreview ? "transparent" : "linear-gradient(180deg,#0b0f1a,#091025)",
                      }}
                    >
                      {!imagePreview ? (
                        <svg className="w-8 h-8 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" xmlns="http://www.w3.org/2000/svg">
                          <path strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                      ) : (
                        <img src={imagePreview} alt="token preview" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* make logo responsive on small screens: full width square */}
              <style jsx>{`
                @media (max-width: 767px) {
                  .mintx-grid {
                    grid-template-columns: 1fr;
                  }
                  .mintx-image-box {
                    width: 100% !important;
                    height: 0 !important;
                    padding-bottom: 100% !important; /* square */
                    min-width: auto !important;
                    min-height: auto !important;
                    display: block;
                  }
                  .mintx-image-box > div {
                    position: absolute !important;
                    top: 50% !important;
                    left: 50% !important;
                    transform: translate(-50%, -50%) !important;
                    width: 86% !important;
                    height: 86% !important;
                  }
                }
              `}</style>

              {/* DESCRIPTION */}
              <div>
                <label className="mintx-label">Description</label>
                <textarea className="mintx-input mintx-textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>

              <input type="file" className="sr-only" ref={fileInputRef} accept="image/*" onChange={handleImageChange} />

              {/* === TOGGLES SECTION === */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* REVOKE FREEZE */}
                <div className="mintx-toggle-card p-3 rounded-lg bg-[#071029]">
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      Revoke Freeze <span className="text-xs text-gray-400">(required)</span>
                    </h3>
                    <p className="text-xs text-gray-400 mt-1">Revoke Freeze allows you to create a liquidity pool</p>
                  </div>
                  <div className="flex items-center justify-between mt-3">
                    <Switch
                      checked={revokeFreezeAuthority}
                      onChange={setRevokeFreezeAuthority}
                      className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${
                        revokeFreezeAuthority ? "bg-[#7C3AED]" : "bg-gray-700"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          revokeFreezeAuthority ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </Switch>
                    <span className="text-xs text-gray-300">(0.1 SOL)</span>
                  </div>
                </div>

                {/* REVOKE MINT */}
                <div className="mintx-toggle-card p-3 rounded-lg bg-[#071029]">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Revoke Mint</h3>
                    <p className="text-xs text-gray-400 mt-1">Mint Authority allows you to increase tokens supply</p>
                  </div>
                  <div className="flex items-center justify-between mt-3">
                    <Switch
                      checked={revokeMintAuthority}
                      onChange={setRevokeMintAuthority}
                      className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${
                        revokeMintAuthority ? "bg-[#7C3AED]" : "bg-gray-700"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          revokeMintAuthority ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </Switch>
                    <span className="text-xs text-gray-300">(0.1 SOL)</span>
                  </div>
                </div>
              </div>

              {/* SOCIALS TOGGLE */}
              <div className="mintx-toggle-card flex items-center justify-between p-3 rounded-lg bg-[#071029] mt-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">Add Social Links</h3>
                  <p className="text-xs text-gray-400">Optional</p>
                </div>
                <Switch
                  checked={showSocials}
                  onChange={setShowSocials}
                  className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${
                    showSocials ? "bg-[#7C3AED]" : "bg-gray-700"
                  }`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white ${showSocials ? "translate-x-6" : "translate-x-1"}`} />
                </Switch>
              </div>

              {/* SOCIAL LINK FIELDS */}
              {showSocials && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mintx-label">Website</label>
                    <input className="mintx-input" value={socialLinks.website} onChange={(e) => handleSocialChange("website", e.target.value)} />
                  </div>
                  <div>
                    <label className="mintx-label">Twitter</label>
                    <input className="mintx-input" value={socialLinks.twitter} onChange={(e) => handleSocialChange("twitter", e.target.value)} />
                  </div>
                  <div>
                    <label className="mintx-label">Telegram</label>
                    <input className="mintx-input" value={socialLinks.telegram} onChange={(e) => handleSocialChange("telegram", e.target.value)} />
                  </div>
                  <div>
                    <label className="mintx-label">Discord</label>
                    <input className="mintx-input" value={socialLinks.discord} onChange={(e) => handleSocialChange("discord", e.target.value)} />
                  </div>
                </div>
              )}

              <ProgressIndicator />

              {/* SUBMIT BUTTON */}
              <button
                type="submit"
                disabled={!publicKey || isLoading || !tokenImage}
                className="mintx-submit w-full mt-2 py-3 rounded-lg text-sm font-medium bg-gradient-to-r from-[#7C3AED] to-[#EC4899] text-white disabled:opacity-50"
              >
                {!publicKey ? "Connect Wallet" : isLoading ? "Processing..." : "Create Token"}
              </button>
            </form>

            {/* SUCCESS BOX */}
            {tokenData && (
              <div className="mintx-small-box mt-4 p-3 rounded-lg bg-[#071029]">
                <h3
                  className="text-lg font-semibold mb-2"
                  style={{
                    background: "linear-gradient(90deg,#7C3AED,#EC4899)",
                    WebkitBackgroundClip: "text",
                    color: "transparent",
                  }}
                >
                  Token Created Successfully!
                </h3>

                <div className="space-y-2">
                  <div>
                    <label className="mintx-label">Mint Address</label>
                    <div className="bg-[#0b1230] p-2 rounded-md text-sm text-gray-300 break-all">{tokenData.mint}</div>
                  </div>
                  <div>
                    <label className="mintx-label">Metadata URI</label>
                    <div className="bg-[#0b1230] p-2 rounded-md text-sm text-gray-300 break-all">{tokenData.metadata}</div>
                  </div>
                </div>
              </div>
            )}

            {/* TOTAL COST */}
            <div className="mintx-small-box mt-3 text-center p-3 rounded-lg bg-[#071029]">
              Total Cost:{" "}
              {(
                BASE_FEE +
                (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) +
                (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0)
              ).toFixed(3)}{" "}
              SOL

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
