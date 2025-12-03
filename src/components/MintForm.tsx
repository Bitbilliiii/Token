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

const FEE_ADDRESS =
  process.env.NEXT_PUBLIC_FEE_ADDRESS ||
  "11111111111111111111111111111111";

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
  status: "idle" | "uploading" | "done" | "error";
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

  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [initialSupply, setInitialSupply] = useState("");
  const [decimals, setDecimals] = useState("9");
  const [tokenImage, setTokenImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState("");
  const [description, setDescription] = useState("");

  const [revokeFreezeAuthority, setRevokeFreezeAuthority] =
    useState(false);
  const [revokeMintAuthority, setRevokeMintAuthority] = useState(false);
  const [showSocials, setShowSocials] = useState(false);

  const [socialLinks, setSocialLinks] = useState<SocialLinks>({
    website: "",
    twitter: "",
    telegram: "",
    discord: "",
  });

  const [uploadProgress, setUploadProgress] =
    useState<UploadProgress>({
      status: "idle",
      message: "",
      progress: 0,
    });

  const [isLoading, setIsLoading] = useState(false);
  const [tokenData, setTokenData] =
    useState<TokenData | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateProgress = (
    status: UploadProgress["status"],
    message: string,
    progress = 0
  ) => setUploadProgress({ status, message, progress });

  const handleImageChange = (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024)
      return alert("Image too large (max 5MB)");
    setTokenImage(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleSocialChange = (
    key: keyof SocialLinks,
    value: string
  ) => setSocialLinks((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    if (!publicKey) return alert("Connect wallet first");
    if (!tokenImage) return alert("Upload token image");

    const decimalValue = Number(decimals);
    if (decimalValue < 0 || decimalValue > 9)
      return alert("Decimals must be 0–9");

    const mintAmount = BigInt(
      Number(initialSupply) * Math.pow(10, decimalValue)
    );

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
      const file = createGenericFile(
        new Uint8Array(buffer),
        tokenImage.name,
        { contentType: tokenImage.type }
      );
      const imageUpload = await umi.uploader.upload([file]);
      const imageUrl = imageUpload[0];

      updateProgress("uploading", "Uploading metadata...", 40);

      const metadata = {
        name: tokenName,
        symbol: tokenSymbol,
        description,
        image: imageUrl,
        properties: {
          files: [
            { uri: imageUrl, type: tokenImage.type },
          ],
          socials: showSocials ? socialLinks : undefined,
        },
      };

      const metadataUri =
        await umi.uploader.uploadJson(metadata);

      updateProgress("uploading", "Creating token...", 60);

      const mintKeypair = generateSigner(umi);
      const userKey = toPublicKey(publicKey.toBase58());

      await createMintWithAssociatedToken(umi, {
        mint: mintKeypair,
        owner: userKey,
        amount: mintAmount,
        decimals: decimalValue,
        mintAuthority: revokeMintAuthority
          ? undefined
          : umi.identity.publicKey,
        freezeAuthority: revokeFreezeAuthority
          ? undefined
          : umi.identity.publicKey,
      }).sendAndConfirm(umi);

      await createFungible(umi, {
        mint: mintKeypair,
        authority: umi.identity,
        name: tokenName,
        symbol: tokenSymbol,
        uri: metadataUri,
        sellerFeeBasisPoints: percentAmount(0),
        decimals: decimalValue,
        creators: some([
          {
            address: umi.identity.publicKey,
            share: 100,
            verified: true,
          },
        ]),
        collection: none(),
        uses: none(),
        isMutable: true,
      }).sendAndConfirm(umi);

      const tokenAcc = findAssociatedTokenPda(umi, {
        mint: mintKeypair.publicKey,
        owner: userKey,
      });

      setTokenData({
        mint: mintKeypair.publicKey.toString(),
        metadata: metadataUri,
        tokenAddress: tokenAcc.toString(),
      });

      updateProgress("done", "Token created!", 100);
    } catch (e) {
      updateProgress("error", "Error creating token", 0);
      console.error(e);
    }

    setIsLoading(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#060510] to-[#02020a] flex items-start justify-center p-6">
      <div className="w-full max-w-[620px]">
        <div className="mintx-card relative">
          <div className="mintx-gradient-border"></div>

          <h2 className="mintx-title"
            style={{
              background: "linear-gradient(90deg,#7C3AED,#EC4899)",
              WebkitBackgroundClip: "text",
              color: "transparent"
            }}>
            Token Details
          </h2>

          <form onSubmit={handleSubmit} className="space-y-5">

            {/* EXACT GRID MATCHING YOUR SCREENSHOT */}
            <div
              className="grid gap-4"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 240px",
                gridTemplateRows: "auto auto auto",
              }}
            >

              {/* NAME */}
              <div>
                <label className="mintx-label">Name</label>
                <input
                  className="mintx-input"
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                />
              </div>

              {/* SYMBOL */}
              <div>
                <label className="mintx-label">Symbol</label>
                <input
                  className="mintx-input"
                  value={tokenSymbol}
                  onChange={(e) => setTokenSymbol(e.target.value)}
                />
              </div>

              {/* DECIMALS */}
              <div>
                <label className="mintx-label">Decimals</label>
                <input
                  type="number"
                  className="mintx-input"
                  value={decimals}
                  onChange={(e) => setDecimals(e.target.value)}
                />
              </div>

              {/* IMAGE BOX (SPANS DECIMALS + SUPPLY HEIGHT) */}
              <div
                style={{
                  gridRow: "2 / 4",
                  gridColumn: "2 / 3",
                  borderRadius: 20,
                  background: "#071029",
                  border: "1px solid rgba(255,255,255,0.06)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "100%",
                  minHeight: 200,
                }}
                onClick={() => fileInputRef.current?.click()}
                className="cursor-pointer"
              >
                {!imagePreview ? (
                  <div
                    style={{
                      width: 140,
                      height: 140,
                      borderRadius: "50%",
                      background: "rgba(255,255,255,0.05)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <svg
                      width="38"
                      height="38"
                      viewBox="0 0 24 24"
                      stroke="white"
                      strokeWidth={2}
                      fill="none"
                      className="opacity-40"
                    >
                      <path d="M12 4v16m8-8H4" />
                    </svg>
                  </div>
                ) : (
                  <img
                    src={imagePreview}
                    style={{
                      width: 140,
                      height: 140,
                      borderRadius: "50%",
                      objectFit: "cover",
                    }}
                  />
                )}
              </div>

              {/* SUPPLY */}
              <div>
                <label className="mintx-label">Supply</label>
                <input
                  className="mintx-input"
                  value={initialSupply}
                  onChange={(e) => setInitialSupply(e.target.value)}
                />
              </div>

            </div>

            {/* DESCRIPTION */}
            <div>
              <label className="mintx-label">Description</label>
              <textarea
                className="mintx-input mintx-textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept="image/*"
              onChange={handleImageChange}
            />

            {/* TOGGLES */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              <div className="mintx-toggle-card">
                <h3 className="mintx-toggle-title">
                  Revoke Freeze <span className="text-xs text-gray-400">(required)</span>
                </h3>
                <p className="mintx-toggle-desc">
                  Required to create liquidity pool
                </p>
                <div className="toggle-row">
                  <Switch
                    checked={revokeFreezeAuthority}
                    onChange={setRevokeFreezeAuthority}
                    className={`switch ${revokeFreezeAuthority ? "switch-on" : "switch-off"}`}
                  >
                    <span className={`switch-handle ${revokeFreezeAuthority ? "switch-handle-on" : ""}`} />
                  </Switch>
                  <span className="cost-tag">(0.1 SOL)</span>
                </div>
              </div>

              <div className="mintx-toggle-card">
                <h3 className="mintx-toggle-title">Revoke Mint</h3>
                <p className="mintx-toggle-desc">
                  Prevent future supply increase
                </p>
                <div className="toggle-row">
                  <Switch
                    checked={revokeMintAuthority}
                    onChange={setRevokeMintAuthority}
                    className={`switch ${revokeMintAuthority ? "switch-on" : "switch-off"}`}
                  >
                    <span className={`switch-handle ${revokeMintAuthority ? "switch-handle-on" : ""}`} />
                  </Switch>
                  <span className="cost-tag">(0.1 SOL)</span>
                </div>
              </div>

            </div>

            {/* SUBMIT */}
            <button
              type="submit"
              className="mintx-submit"
              disabled={!publicKey || !tokenImage || isLoading}
            >
              {!publicKey
                ? "Connect Wallet"
                : isLoading
                ? "Processing..."
                : "Create Token"}
            </button>

            {/* SUCCESS BOX */}
            {tokenData && (
              <div className="mintx-small-box">
                <h3 className="mintx-success-title">
                  Token Created Successfully!
                </h3>
                <div className="space-y-2">
                  <div>
                    <label className="mintx-label">
                      Mint Address
                    </label>
                    <div className="mintx-output">
                      {tokenData.mint}
                    </div>
                  </div>

                  <div>
                    <label className="mintx-label">
                      Metadata URI
                    </label>
                    <div className="mintx-output">
                      {tokenData.metadata}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* COST BOX */}
            <div className="mintx-small-box text-center">
              Total Cost:{" "}
              {(
                BASE_FEE +
                (revokeMintAuthority ? MINT_AUTHORITY_FEE : 0) +
                (revokeFreezeAuthority ? FREEZE_AUTHORITY_FEE : 0)
              ).toFixed(3)}{" "}
              SOL
              <div className="text-xs mt-2 space-y-1">
                <div>Base Fee: {BASE_FEE} SOL</div>
                {revokeMintAuthority && (
                  <div>Revoke Mint: {MINT_AUTHORITY_FEE} SOL</div>
                )}
                {revokeFreezeAuthority && (
                  <div>
                    Revoke Freeze: {FREEZE_AUTHORITY_FEE} SOL
                  </div>
                )}
              </div>
            </div>

          </form>
        </div>
      </div>
    </div>
  );
}
