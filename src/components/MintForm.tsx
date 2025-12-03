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
import { useRef, useState } from "react";

const FEE_ADDRESS = process.env.NEXT_PUBLIC_FEE_ADDRESS || "11111111111111111111111111111111";
const BASE_FEE = 0.05;
const MINT_AUTHORITY_FEE = 0.0123;
const FREEZE_AUTHORITY_FEE = 0.0123;

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
  const { publicKey } = useWallet();
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

  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateProgress = (status: UploadProgress["status"], message: string, progress = 0) => {
    setUploadProgress({ status, message, progress });
  };

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

  const handleSocialChange = (key: keyof SocialLinks, v: string) => {
    setSocialLinks((p) => ({ ...p, [key]: v }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!publicKey) return alert("Connect wallet");
    if (!tokenImage) return alert("Upload token logo");

    const dec = Number(decimals);
    if (isNaN(dec) || dec < 0 || dec > 9) return alert("Decimals must be 0–9");
    if (!initialSupply || Number(initialSupply) <= 0) return alert("Enter initial supply");

    const mintAmount = BigInt(Number(initialSupply) * Math.pow(10, dec));

    try {
      setIsLoading(true);
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

      const buffer = await tokenImage.arrayBuffer();
      const file = createGenericFile(new Uint8Array(buffer), tokenImage.name, {
        contentType: tokenImage.type,
      });

      const uploaded = await umi.uploader.upload([file]);
      const imageUrl = uploaded[0];

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
      const user = toPublicKey(publicKey.toBase58());

      await createMintWithAssociatedToken(umi, {
        mint: mintKeypair,
        owner: user,
        amount: mintAmount,
        decimals: dec,
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
        decimals: dec,
        creators: some([{ address: umi.identity.publicKey, share: 100, verified: true }]),
        collection: none(),
        uses: none(),
        isMutable: true,
      }).sendAndConfirm(umi);

      const tokenAcc = findAssociatedTokenPda(umi, {
        mint: mintKeypair.publicKey,
        owner: user,
      });

      setTokenData({
        mint: mintKeypair.publicKey.toString(),
        metadata: metadataUri,
        tokenAddress: tokenAcc.toString(),
      });

      updateProgress("done", "Token created!", 100);
    } catch (err) {
      console.error(err);
      updateProgress("error", "Error creating token", 0);
    } finally {
      setIsLoading(false);
    }
  };

  const ProgressIndicator = () => {
    if (uploadProgress.status === "idle") return null;
    const bg =
      uploadProgress.status === "done"
        ? "bg-green-500"
        : uploadProgress.status === "error"
        ? "bg-red-500"
        : "bg-[#7C3AED]";
    return (
      <div className="mt-3">
        <div className="flex justify-between text-sm mb-1">
          <span className="text-gray-300">{uploadProgress.message}</span>
          <span className="text-gray-400">{uploadProgress.progress}%</span>
        </div>
        <div className="w-full h-2 rounded-full bg-black/50">
          <div className={`h-2 rounded-full ${bg}`} style={{ width: `${uploadProgress.progress}%` }} />
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#060510] to-[#02020a] flex justify-center p-6">
      <div className="w-full max-w-[640px]"> {/* slightly wider for desktop spacing */}
        <div className="mintx-card relative rounded-2xl p-6" style={{ background: "linear-gradient(180deg,#0a0b17 0%, #0f1020 100%)", boxShadow: "0 8px 30px rgba(0,0,0,0.6)" }}>
          <div className="mintx-gradient-border" />

          <h2
            className="mintx-title mb-4"
            style={{
              background: "linear-gradient(90deg,#7C3AED,#EC4899)",
              WebkitBackgroundClip: "text",
              color: "transparent",
              fontSize: 20,
              fontWeight: 700,
            }}
          >
            Token Details
          </h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* GRID: explicit rows so image can span rows 3..5 (Decimals + Supply) */}
            <div
              className="mintx-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 220px",
                gridTemplateRows: "auto auto auto auto",
                gap: "14px",
                alignItems: "start",
              }}
            >
              {/* Name -> grid row 1 col 1 */}
              <div style={{ gridColumn: "1 / 2", gridRow: "1 / 2" }}>
                <label className="mintx-label">Name</label>
                <input
                  className="mintx-input"
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                  placeholder="e.g. My Amazing Token"
                />
              </div>

              {/* Image placeholder sits in column 2 and spans rows 3..5 (so it covers decimals + supply) */}
              <div style={{ gridColumn: "2 / 3", gridRow: "3 / 5", display: "flex", justifyContent: "center", alignItems: "start" }}>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="cursor-pointer rounded-xl"
                  style={{
                    width: "100%",
                    height: "100%",
                    minHeight: 150,
                    borderRadius: 14,
                    background: "#0b1430",
                    border: "1px solid rgba(255,255,255,0.04)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 16,
                  }}
                  aria-label="Upload token logo"
                >
                  {!imagePreview ? (
                    <div style={{ width: 120, height: 120, borderRadius: 9999, background: "rgba(255,255,255,0.02)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <span style={{ fontSize: 32, color: "rgba(255,255,255,0.24)" }}>+</span>
                    </div>
                  ) : (
                    <img
                      src={imagePreview}
                      alt="preview"
                      style={{ width: 120, height: 120, borderRadius: 9999, objectFit: "cover", display: "block" }}
                    />
                  )}
                </div>
              </div>

              {/* Symbol -> grid row 2 col 1 */}
              <div style={{ gridColumn: "1 / 2", gridRow: "2 / 3" }}>
                <label className="mintx-label">Symbol</label>
                <input className="mintx-input" value={tokenSymbol} onChange={(e) => setTokenSymbol(e.target.value)} placeholder="e.g. MAT" />
              </div>

              {/* Decimals -> grid row 3 col 1 */}
              <div style={{ gridColumn: "1 / 2", gridRow: "3 / 4" }}>
                <label className="mintx-label">Decimals</label>
                <input
                  className="mintx-input"
                  value={decimals}
                  onChange={(e) => setDecimals(e.target.value)}
                  placeholder="e.g. 9"
                />
              </div>

              {/* Supply -> grid row 4 col 1 */}
              <div style={{ gridColumn: "1 / 2", gridRow: "4 / 5" }}>
                <label className="mintx-label">Supply</label>
                <input className="mintx-input" value={initialSupply} onChange={(e) => setInitialSupply(e.target.value)} placeholder="e.g. 1000000" />
              </div>
            </div>

            {/* description full width */}
            <div>
              <label className="mintx-label">Description</label>
              <textarea className="mintx-input mintx-textarea" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
            </div>

            <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleImageChange} />

            {/* Revoke Freeze + Revoke Mint */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="mintx-toggle-card p-3 rounded-lg bg-[#071029]">
                <h3 className="text-sm font-semibold text-white">
                  Revoke Freeze <span className="text-xs text-gray-400">(required)</span>
                </h3>
                <p className="text-xs text-gray-400 mt-1">Revoke Freeze allows you to create a liquidity pool</p>
                <div className="flex justify-between items-center mt-3">
                  <Switch
                    checked={revokeFreezeAuthority}
                    onChange={setRevokeFreezeAuthority}
                    className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${revokeFreezeAuthority ? "bg-teal-400" : "bg-gray-700"}`}
                  >
                    <span className={`inline-block h-4 w-4 bg-white rounded-full transform transition-all ${revokeFreezeAuthority ? "translate-x-6" : "translate-x-1"}`} />
                  </Switch>
                  <span className="text-xs text-gray-300">(0.1 SOL)</span>
                </div>
              </div>

              <div className="mintx-toggle-card p-3 rounded-lg bg-[#071029]">
                <h3 className="text-sm font-semibold text-white">Revoke Mint</h3>
                <p className="text-xs text-gray-400 mt-1">Mint Authority allows you to increase tokens supply</p>
                <div className="flex justify-between items-center mt-3">
                  <Switch
                    checked={revokeMintAuthority}
                    onChange={setRevokeMintAuthority}
                    className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${revokeMintAuthority ? "bg-[#7C3AED]" : "bg-gray-700"}`}
                  >
                    <span className={`inline-block h-4 w-4 bg-white rounded-full transform transition-all ${revokeMintAuthority ? "translate-x-6" : "translate-x-1"}`} />
                  </Switch>
                  <span className="text-xs text-gray-300">(0.1 SOL)</span>
                </div>
              </div>
            </div>

            {/* Socials toggle + fields */}
            <div className="mintx-toggle-card flex justify-between items-center p-3 rounded-lg bg-[#071029]">
              <div>
                <h3 className="text-sm font-semibold text-white">Add Social Links</h3>
                <p className="text-xs text-gray-400">Optional but recommended</p>
              </div>
              <Switch
                checked={showSocials}
                onChange={setShowSocials}
                className={`relative inline-flex h-6 w-11 rounded-full transition-all duration-300 ${showSocials ? "bg-[#7C3AED]" : "bg-gray-700"}`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white transform transition-all ${showSocials ? "translate-x-6" : "translate-x-1"}`} />
              </Switch>
            </div>

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

            <button
              type="submit"
              disabled={!publicKey || isLoading || !tokenImage}
              className="mintx-submit w-full mt-2 py-3 bg-gradient-to-r from-[#7C3AED] to-[#EC4899] rounded-lg text-white text-sm font-medium disabled:opacity-50"
            >
              {!publicKey ? "Connect Wallet" : isLoading ? "Processing..." : "Create Token"}
            </button>
          </form>

          {/* Success / cost boxes */}
          {tokenData && (
            <div className="mintx-small-box mt-4 p-3 rounded-lg bg-[#071029]">
              <h3 className="text-lg font-semibold mb-2" style={{ background: "linear-gradient(90deg,#7C3AED,#EC4899)", WebkitBackgroundClip: "text", color: "transparent" }}>
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

          <div className="mintx-small-box mt-3 text-center p-3 bg-[#071029] rounded-lg">
            Total Cost:{" "}
            {(
              BASE_FEE +
              (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) +
              (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0)
            ).toFixed(3)}{" "}
            SOL
          </div>
        </div>
      </div>
    </div>
  );
}
