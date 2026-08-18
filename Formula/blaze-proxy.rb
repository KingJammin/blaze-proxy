class BlazeProxy < Formula
  desc "Desktop AI model router - intercept model requests, serve from your own endpoint"
  homepage "https://github.com/KingJammin/blaze-proxy"
  url "https://github.com/KingJammin/blaze-proxy/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "103fb72530d9ae7f6de5d50ed0835dcc42a623a67cee004198ce0486c218816a"
  license "MIT"

  depends_on "node"

  def install
    # Headless install: the Electron UI is an optional dependency; machines
    # that want it can run `npm install -g electron` or use the npm channel.
    system "npm", "install", *std_npm_args, "--omit=optional"
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  service do
    run [opt_bin/"blaze-proxy", "start"]
    keep_alive true
    log_path var/"log/blaze-proxy.log"
    error_log_path var/"log/blaze-proxy.error.log"
  end

  test do
    assert_match "usage: blaze-proxy", shell_output("#{bin}/blaze-proxy help 2>&1", 1)
  end
end
