import { Table, TableHead, TableBody, TableRow, TableCell, Typography, Link } from '@mui/material'
import { makeStyles } from '@masknet/theme'
import { Image } from '../../../components/shared/Image'
import { ERC20TokenDetailed, useChainId, formatBalance } from '@masknet/web3-shared-evm'
import { resolveAssetLinkOnOpenSea } from '../pipes'
import { useI18N } from '../../../utils'
import type { useAsset } from '../../EVM/hooks/useAsset'
import type { useAssetOrder } from '../hooks/useAssetOrder'
import type { Order } from 'opensea-js/lib/types'

const useStyles = makeStyles()((theme) => ({
    itemInfo: {
        display: 'flex',
        alignItems: 'center',
    },
    texts: {
        marginLeft: theme.spacing(1),
    },
}))

export interface CheckoutOrderProps {
    asset?: ReturnType<typeof useAsset>
    assetOrder?: ReturnType<typeof useAssetOrder>
}

export function CheckoutOrder(props: CheckoutOrderProps) {
    const { t } = useI18N()
    const { asset, assetOrder } = props
    const order = assetOrder?.value ?? asset?.value?.desktopOrder
    const { classes } = useStyles()
    const chainId = useChainId()
    if (!asset?.value) return null
    if (!order) return null

    const price = (order as Order).currentPrice ?? asset.value.current_price
    const getPrice = () => {
        if (!price) return 'error'
        const decimal = asset.value?.response_.collection.payment_tokens.find((item: ERC20TokenDetailed) => {
            return item.symbol === asset.value?.current_symbol
        })?.decimals
        if (!decimal) return 'error'
        return formatBalance(price, decimal) ?? 'error'
    }

    return (
        <Table size="small">
            <TableHead>
                <TableRow>
                    <TableCell>{t('plugin_collectible_item')}</TableCell>
                    <TableCell align="right">{t('plugin_collectible_subtotal')}</TableCell>
                </TableRow>
            </TableHead>
            <TableBody>
                <TableRow>
                    <TableCell>
                        <div className={classes.itemInfo}>
                            <Image height={80} width={80} src={asset.value?.image_url ?? ''} />
                            <div className={classes.texts}>
                                <Typography>{asset.value.collection_name ?? ''}</Typography>
                                {asset.value.token_address && asset.value.token_id ? (
                                    <Link
                                        color="primary"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        href={resolveAssetLinkOnOpenSea(
                                            chainId,
                                            asset.value.token_address,
                                            asset.value.token_id,
                                        )}>
                                        <Typography>{asset.value.name ?? ''}</Typography>
                                    </Link>
                                ) : (
                                    <Typography>{asset.value.name ?? ''}</Typography>
                                )}
                            </div>
                        </div>
                    </TableCell>
                    <TableCell align="right">
                        <Typography>
                            {getPrice()} {asset.value.current_symbol}
                        </Typography>
                    </TableCell>
                </TableRow>
                <TableRow>
                    <TableCell>
                        <Typography>{t('plugin_collectible_total')}</Typography>
                    </TableCell>
                    <TableCell align="right">
                        <Typography>
                            {getPrice()} {asset.value.current_symbol}
                        </Typography>
                    </TableCell>
                </TableRow>
            </TableBody>
        </Table>
    )
}
