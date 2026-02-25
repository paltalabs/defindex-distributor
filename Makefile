build:
	stellar contract build
	stellar contract optimize --wasm target/wasm32v1-none/release/defindex_distributor.wasm

test:
	cargo test;

clean:
	rm -rf target;